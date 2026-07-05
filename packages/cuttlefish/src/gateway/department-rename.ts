import fs from "node:fs";
import path from "node:path";
import { ORG_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { safeWriteText } from "../shared/safe-write.js";
import { findEmployeeYamlPath, scanOrg, updateEmployeeYaml } from "./org.js";

export type RenameDepartmentResult =
  | { ok: true; department: string; previousDepartment: string; employees: string[]; movedDirectory: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

interface EmployeeYamlSnapshot {
  name: string;
  filePath: string;
  raw: string;
}

function validateDepartmentName(value: string, field: string): string | null {
  if (!value.trim()) return `${field} must be a non-empty string`;
  if (path.isAbsolute(value)) return `${field} must not be an absolute path`;
  if (value.includes("..")) return `${field} must not contain '..' traversal`;
  if (value.includes("/") || value.includes("\\")) return `${field} must not contain path separators`;
  return null;
}

function snapshotEmployeeYamls(employees: string[]): EmployeeYamlSnapshot[] | string {
  const snapshots: EmployeeYamlSnapshot[] = [];
  for (const name of employees) {
    const filePath = findEmployeeYamlPath(name);
    if (!filePath) return `failed to find employee "${name}"`;
    try {
      snapshots.push({ name, filePath, raw: fs.readFileSync(filePath, "utf-8") });
    } catch (err) {
      return `failed to read employee "${name}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return snapshots;
}

function restoreEmployeeYamls(snapshots: EmployeeYamlSnapshot[]): boolean {
  let restored = true;
  for (const snapshot of snapshots) {
    try {
      safeWriteText(snapshot.filePath, snapshot.raw, {
        audit: { actor: "gateway", op: "org.department.rename.rollback" },
      });
    } catch (err) {
      restored = false;
      logger.warn(`Failed to restore employee YAML for ${snapshot.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return restored;
}

export function renameDepartment(
  oldDepartment: string,
  newDepartment: string,
  orgDir = ORG_DIR,
): RenameDepartmentResult {
  const previousDepartment = oldDepartment.trim();
  const department = newDepartment.trim();
  const oldError = validateDepartmentName(previousDepartment, "current department");
  if (oldError) return { ok: false, status: 400, error: oldError };
  const newError = validateDepartmentName(department, "new department");
  if (newError) return { ok: false, status: 400, error: newError };
  if (previousDepartment === department) {
    return { ok: false, status: 400, error: "new department must differ from current department" };
  }

  const registry = scanOrg();
  const employees = [...registry.values()]
    .filter((employee) => employee.department === previousDepartment)
    .map((employee) => employee.name)
    .sort((a, b) => a.localeCompare(b));

  const oldDir = path.join(orgDir, previousDepartment);
  const newDir = path.join(orgDir, department);
  const oldDirExists = fs.existsSync(oldDir);
  if (employees.length === 0 && !oldDirExists) {
    return { ok: false, status: 404, error: `department "${previousDepartment}" was not found` };
  }
  if (fs.existsSync(newDir)) {
    return { ok: false, status: 409, error: `department "${department}" already exists` };
  }

  const snapshots = snapshotEmployeeYamls(employees);
  if (typeof snapshots === "string") {
    return { ok: false, status: 409, error: snapshots };
  }
  const rollback = (reason: string): RenameDepartmentResult => {
    const restored = restoreEmployeeYamls(snapshots);
    return {
      ok: false,
      status: 409,
      error: restored ? reason : `${reason}; rollback failed, inspect org files`,
    };
  };

  for (const employeeName of employees) {
    const wrote = updateEmployeeYaml(employeeName, { department });
    if (!wrote) {
      return rollback(`failed to update employee "${employeeName}"`);
    }
  }

  let movedDirectory = false;
  if (oldDirExists) {
    try {
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      fs.renameSync(oldDir, newDir);
    } catch (err) {
      return rollback(`failed to move department directory: ${err instanceof Error ? err.message : String(err)}`);
    }
    movedDirectory = true;
  }

  return { ok: true, previousDepartment, department, employees, movedDirectory };
}
