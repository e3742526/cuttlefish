import fs from "node:fs";
import path from "node:path";
import { ORG_DIR } from "../shared/paths.js";
import { scanOrg, updateEmployeeYaml } from "./org.js";

export type RenameDepartmentResult =
  | { ok: true; department: string; previousDepartment: string; employees: string[]; movedDirectory: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

function validateDepartmentName(value: string, field: string): string | null {
  if (!value.trim()) return `${field} must be a non-empty string`;
  if (path.isAbsolute(value)) return `${field} must not be an absolute path`;
  if (value.includes("..")) return `${field} must not contain '..' traversal`;
  if (value.includes("/") || value.includes("\\")) return `${field} must not contain path separators`;
  return null;
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

  for (const employeeName of employees) {
    const wrote = updateEmployeeYaml(employeeName, { department });
    if (!wrote) {
      return { ok: false, status: 409, error: `failed to update employee "${employeeName}"` };
    }
  }

  let movedDirectory = false;
  if (oldDirExists) {
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    movedDirectory = true;
  }

  return { ok: true, previousDepartment, department, employees, movedDirectory };
}
