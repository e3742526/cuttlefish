import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, ArrowLeft } from "lucide-react";
import { useTheme } from "@/routes/providers";
import { SyntaxHighlighter, syntaxTheme } from "@/lib/syntax-highlighter";

/** Shape returned by GET /api/files/read?path=<path>. */
interface FileReadResponse {
  content?: string;
  mime: string;
  size: number;
  path: string;
  resolvedPath: string;
  binary?: boolean;
  tooLarge?: boolean;
}

/** Map a file extension to a Prism language identifier. Falls back to plaintext. */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  css: "css",
  scss: "scss",
  less: "less",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "docker",
  md: "markdown",
  markdown: "markdown",
};

const MARKDOWN_EXTS = new Set(["md", "markdown"]);

/** Extract a lowercase extension (without the dot) from a path, "" if none. */
function getExt(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base.toLowerCase(); // e.g. "Dockerfile" → "dockerfile"
  return base.slice(dot + 1).toLowerCase();
}

/** Human-readable byte size. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shared file viewer. Fetches a file via GET /api/files/read and renders it as
 * markdown or syntax-highlighted code. Used both standalone (the /file route)
 * and embedded inside an in-app tab.
 *
 * - `embedded === true`: no header chrome, fills its parent and scrolls
 *   internally, shows a subtle "open in new browser tab" affordance.
 * - `embedded` falsy: slim sticky header with the path, page-level scroll,
 *   sets document.title to the basename.
 */
export function FileView({
  path,
  embedded,
  onBack,
}: {
  path: string;
  embedded?: boolean;
  /** Mobile-only "back to chat" handler. When set, the embedded view shows a
   *  back button (hidden on desktop, which has the tab bar instead). */
  onBack?: () => void;
}) {
  const { theme } = useTheme();

  const [data, setData] = useState<FileReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  // Resolve whether to use a dark or light highlighter theme. ThemeProvider
  // sets data-theme on <html>; "light" is the only light variant.
  const isDark = useMemo(() => {
    if (typeof document !== "undefined") {
      const attr = document.documentElement.getAttribute("data-theme");
      if (attr) return attr !== "light";
    }
    return theme !== "light";
  }, [theme]);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      setError("No file path provided");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setData(null);

    fetch(`/api/files/read?path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return null;
        }
        if (!res.ok) {
          let msg = `Failed to load file (${res.status})`;
          try {
            const body = await res.json();
            if (body?.error) msg = String(body.error);
          } catch {
            /* not JSON */
          }
          throw new Error(msg);
        }
        return (await res.json()) as FileReadResponse;
      })
      .then((json) => {
        if (!cancelled && json) setData(json);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  // Set the document title to the file name for the standalone tab only.
  useEffect(() => {
    if (embedded) return;
    if (path) {
      const name = path.split(/[\\/]/).pop() ?? path;
      document.title = name;
    }
  }, [path, embedded]);

  const ext = getExt(path);
  const isMarkdown = MARKDOWN_EXTS.has(ext) || data?.mime === "text/markdown";
  const lang = EXT_TO_LANG[ext] ?? "text";
  const codeTheme = syntaxTheme(isDark);

  const body = (
    <>
      {loading && (
        <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
          Loading…
        </p>
      )}

      {!loading && notFound && (
        <div
          className="rounded-[var(--radius-md,12px)] py-[var(--space-4)] px-[var(--space-4)] text-[length:var(--text-body)] text-[var(--system-red)]"
          style={{
            background:
              "color-mix(in srgb, var(--system-red) 10%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)",
          }}
        >
          File not found: {path}
        </div>
      )}

      {!loading && error && !notFound && (
        <div
          className="rounded-[var(--radius-md,12px)] py-[var(--space-4)] px-[var(--space-4)] text-[length:var(--text-body)] text-[var(--system-red)]"
          style={{
            background:
              "color-mix(in srgb, var(--system-red) 10%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)",
          }}
        >
          {error}
        </div>
      )}

      {!loading && data && data.tooLarge && (
        <div className="text-[length:var(--text-body)] text-[var(--text-secondary)]">
          File too large to preview ({formatSize(data.size)}).
        </div>
      )}

      {!loading && data && !data.tooLarge && data.binary && (
        <div className="text-[length:var(--text-body)] text-[var(--text-secondary)]">
          <p>
            Binary file ({data.mime}, {formatSize(data.size)}) — cannot
            preview.
          </p>
          <a
            href={`/api/files/read?path=${encodeURIComponent(path)}`}
            download
            className="inline-block mt-[var(--space-3)] text-[var(--accent)] underline"
          >
            Download file
          </a>
        </div>
      )}

      {!loading &&
        data &&
        !data.tooLarge &&
        !data.binary &&
        data.content !== undefined &&
        (isMarkdown ? (
          <MarkdownView content={data.content} isDark={isDark} />
        ) : (
          <SyntaxHighlighter
            language={lang}
            style={codeTheme}
            customStyle={{
              margin: 0,
              maxWidth: "100%",
              borderRadius: "var(--radius-md, 12px)",
              fontSize: "13px",
              fontFamily: "var(--font-mono)",
              border: "1px solid var(--separator)",
            }}
            codeTagProps={{ style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }}
            showLineNumbers
            wrapLongLines
          >
            {data.content}
          </SyntaxHighlighter>
        ))}
    </>
  );

  // Embedded: headerless, fills parent, scrolls internally. The "h-full
  // overflow-y-auto min-h-0" trio is the scroll fix — the parent gives this a
  // bounded flex height and long files now scroll inside the tab instead of
  // being clipped.
  if (embedded) {
    return (
      <div
        className="relative h-full min-h-0 overflow-y-auto overflow-x-hidden"
        style={{ background: "var(--bg)", color: "var(--text-primary)" }}
      >
        {/* Sticky control row: stays pinned at the top of the scroll viewport so
            the buttons remain reachable while scrolling. The row itself is
            transparent and click-through (content scrolls behind it); each
            control is a subtle frosted pill so it reads clearly over markdown
            or code. Back on the left (shown whenever onBack is provided — all
            sizes), pop-out on the right. */}
        <div className="pointer-events-none sticky top-0 z-10 flex items-center justify-between px-3 py-2">
          {onBack ? (
            <button
              onClick={onBack}
              title="Back to chat"
              aria-label="Back to chat"
              className="pointer-events-auto inline-flex size-8 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--material-thick)] text-[var(--text-tertiary)] backdrop-blur-md transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]"
            >
              <ArrowLeft size={16} />
            </button>
          ) : (
            <span />
          )}
          <a
            href={`/file?path=${encodeURIComponent(path)}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in new browser tab"
            className="pointer-events-auto inline-flex size-8 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--material-thick)] text-[var(--text-tertiary)] backdrop-blur-md transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]"
          >
            <ExternalLink size={16} />
          </a>
        </div>
        {/* Content starts just below the sticky row (which reserves its own
            height); on scroll it slides up behind the floating chips. min-w-0
            lets children (code blocks) cap their own width instead of pushing
            the pane wider. */}
        <div className="px-[var(--space-6)] pb-[var(--space-6)] pt-[var(--space-2)] max-w-[960px] mx-auto min-w-0">
          {body}
        </div>
      </div>
    );
  }

  // Standalone: slim sticky header + its OWN scroll container. The app shell is
  // height-constrained / overflow-hidden, so a plain min-h-screen page can't
  // grow and long files get clipped. h-[100dvh] overflow-y-auto makes this view
  // scroll on its own (dvh so mobile browser chrome doesn't cut off the bottom);
  // the sticky header stays pinned at the top of the scroll container.
  return (
    <div
      className="h-[100dvh] w-full overflow-y-auto overflow-x-hidden"
      style={{ background: "var(--bg)", color: "var(--text-primary)" }}
    >
      {/* Header — in normal flow (scrolls away with content, not pinned). */}
      <header
        className="px-[var(--space-6)] py-[var(--space-4)]"
        style={{
          background: "var(--material-thick)",
          borderBottom: "1px solid var(--separator)",
          backdropFilter: "blur(20px)",
        }}
      >
        <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
          File
        </p>
        <h1
          className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)] break-all"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {path || "(no path)"}
        </h1>
        {data && (
          <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-[var(--space-1)]">
            {data.mime} · {formatSize(data.size)}
          </p>
        )}
      </header>

      {/* Body */}
      <main className="px-[var(--space-6)] py-[var(--space-6)] max-w-[960px] mx-auto min-w-0">
        {body}
      </main>
    </div>
  );
}

/** GitHub-flavored markdown rendering with highlighted fenced code blocks. */
function MarkdownView({
  content,
  isDark,
}: {
  content: string;
  isDark: boolean;
}) {
  const codeTheme = syntaxTheme(isDark);
  return (
    <div className="cuttlefish-markdown min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-[length:var(--text-body)] leading-[1.7] text-[var(--text-secondary)]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1
              className="text-[length:var(--text-title1)] font-[var(--weight-bold)] mt-[var(--space-6)] mb-[var(--space-3)]"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              className="text-[length:var(--text-title2)] font-[var(--weight-semibold)] mt-[var(--space-6)] mb-[var(--space-2)] pb-[var(--space-1)]"
              style={{
                color: "var(--text-primary)",
                borderBottom: "1px solid var(--separator)",
              }}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] mt-[var(--space-5)] mb-[var(--space-2)]"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4
              className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] mt-[var(--space-4)] mb-[var(--space-1)]"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="mb-[var(--space-4)]">{children}</p>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
              className="underline"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="list-disc ml-[var(--space-6)] mb-[var(--space-4)] space-y-[var(--space-1)]">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal ml-[var(--space-6)] mb-[var(--space-4)] space-y-[var(--space-1)]">
              {children}
            </ol>
          ),
          blockquote: ({ children }) => (
            <blockquote
              className="pl-[var(--space-4)] my-[var(--space-4)]"
              style={{
                borderLeft: "3px solid var(--separator)",
                color: "var(--text-tertiary)",
              }}
            >
              {children}
            </blockquote>
          ),
          strong: ({ children }) => (
            <strong
              className="font-[var(--weight-semibold)]"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </strong>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto mb-[var(--space-4)]">
              <table
                className="border-collapse w-full text-[length:var(--text-subheadline)]"
                style={{ border: "1px solid var(--separator)" }}
              >
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th
              className="text-left px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-semibold)]"
              style={{
                border: "1px solid var(--separator)",
                color: "var(--text-primary)",
                background: "var(--fill-tertiary)",
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              className="px-[var(--space-3)] py-[var(--space-2)]"
              style={{ border: "1px solid var(--separator)" }}
            >
              {children}
            </td>
          ),
          hr: () => (
            <hr
              className="my-[var(--space-6)]"
              style={{ border: 0, borderTop: "1px solid var(--separator)" }}
            />
          ),
          code(props) {
            const { children, className, node, ...rest } = props as {
              children?: React.ReactNode;
              className?: string;
              node?: unknown;
              inline?: boolean;
            };
            const match = /language-(\w+)/.exec(className ?? "");
            const text = String(children ?? "").replace(/\n$/, "");
            // Inline code (no language class and no newline) → styled <code>.
            const isInline = !match && !text.includes("\n");
            if (isInline) {
              return (
                <code
                  style={{
                    background: "var(--fill-secondary)",
                    color: "var(--accent)",
                    padding: "2px 6px",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontFamily: "var(--font-mono)",
                  }}
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <SyntaxHighlighter
                language={match ? match[1] : "text"}
                style={codeTheme}
                customStyle={{
                  margin: "0 0 var(--space-4) 0",
                  maxWidth: "100%",
                  borderRadius: "var(--radius-md, 12px)",
                  fontSize: "13px",
                  fontFamily: "var(--font-mono)",
                  border: "1px solid var(--separator)",
                }}
                codeTagProps={{ style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }}
                wrapLongLines
              >
                {text}
              </SyntaxHighlighter>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
