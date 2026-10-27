/**
 * MCP server for six small hosted APIs, called through RapidAPI with the user's own key.
 *
 *   RAPIDAPI_KEY        required; one key works for every API you subscribe to
 *   <API>_HOST          optional override of an API's X-RapidAPI-Host (OG_IMAGE_HOST, WEB_PAGE_HOST, ...)
 *   <API>_BASE_URL      optional override of the whole base URL; used by the tests
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const VERSION = "0.2.0";

const APIS = {
  OG_IMAGE: { host: "og-image-api1.p.rapidapi.com", docs: "https://og-image-api.fly.dev/" },
  WEB_PAGE: { host: "web-page-api.p.rapidapi.com", docs: "https://web-page-api.fly.dev/" },
  JOB_PARSER: { host: "job-posting-parser.p.rapidapi.com", docs: "https://job-parser-api.fly.dev/" },
  RESUME_MATCH: { host: "resume-parser-job-match.p.rapidapi.com", docs: "https://resume-match-api.fly.dev/" },
  SKILL_RATING: { host: "skill-rating-api.p.rapidapi.com", docs: "https://ranking-api.fly.dev/" },
  // PLACEHOLDER: host and docs URL follow the naming of the others; confirm both once
  // hot-lists-api is listed on RapidAPI and deployed (users can override with HOT_LISTS_HOST).
  HOT_LISTS: { host: "hot-lists-api.p.rapidapi.com", docs: "https://hot-lists-api.fly.dev/" },
} as const;
type Api = keyof typeof APIS;

class ApiError extends Error {}

function host(api: Api): string {
  return process.env[`${api}_HOST`] || APIS[api].host;
}

function baseUrl(api: Api): string {
  return (process.env[`${api}_BASE_URL`] || `https://${host(api)}`).replace(/\/$/, "");
}

async function call(
  api: Api,
  path: string,
  init: { method?: string; query?: Record<string, unknown>; json?: unknown; form?: FormData } = {},
): Promise<Response> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    throw new ApiError(
      `RAPIDAPI_KEY is not set. Subscribe to the API (a free plan is available) via ${APIS[api].docs} ` +
        "and set your RapidAPI key as RAPIDAPI_KEY in this MCP server's environment.",
    );
  }
  const url = new URL(baseUrl(api) + path);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    "X-RapidAPI-Key": key,
    "X-RapidAPI-Host": host(api),
    "User-Agent": `keith-apis-mcp/${VERSION}`,
  };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) {
    body = init.form;
  }
  const res = await fetch(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
  if (!res.ok) {
    const text = await res.text();
    let message = text.slice(0, 2000);
    try {
      const j = JSON.parse(text);
      message = j?.error?.message ?? j?.message ?? j?.detail ?? message;
      if (typeof message !== "string") message = JSON.stringify(message);
    } catch {
      // not JSON: keep the raw text
    }
    if (res.status === 401 || res.status === 403) {
      message += ` (check that RAPIDAPI_KEY is valid and subscribed to this API: ${APIS[api].docs})`;
    }
    throw new ApiError(`HTTP ${res.status}: ${message}`);
  }
  return res;
}

async function jsonResult(res: Promise<Response>) {
  const data = await (await res).json();
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Turns thrown errors into an MCP tool error the model can read. */
function tool<A>(fn: (args: A) => Promise<{ content: any[] }>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const PURE = { readOnlyHint: true, openWorldHint: false, idempotentHint: true } as const;

export function createServer(): McpServer {
  const server = new McpServer({ name: "keith-apis", version: VERSION });

  // ---- Web Page API -------------------------------------------------------
  server.registerTool(
    "fetch_url_as_markdown",
    {
      title: "Web page to Markdown",
      description:
        "Fetch a public web page and return its main content as clean Markdown (navigation, ads and " +
        "boilerplate removed), with the title and metadata. Use it to read an article or docs page for " +
        "summarising, quoting or RAG. Respects robots.txt.",
      inputSchema: {
        url: z.string().url().describe("http(s) URL of the page"),
        include_links: z.boolean().optional().describe("Keep hyperlinks in the Markdown (default false)"),
        include_images: z.boolean().optional().describe("Keep images in the Markdown (default false)"),
        max_chars: z.number().int().min(100).max(1_000_000).optional().describe("Truncate the Markdown (default 100,000)"),
      },
      annotations: READ_ONLY,
    },
    tool((a) => jsonResult(call("WEB_PAGE", "/v1/markdown", { query: a }))),
  );

  server.registerTool(
    "html_to_markdown",
    {
      title: "HTML to Markdown",
      description: "Convert HTML you already have into clean Markdown of its main content. Nothing is fetched.",
      inputSchema: {
        html: z.string().min(1).describe("The page's HTML"),
        base_url: z.string().optional().describe("URL the HTML came from, used to resolve relative links"),
        include_links: z.boolean().optional(),
        include_images: z.boolean().optional(),
        max_chars: z.number().int().min(100).max(1_000_000).optional(),
      },
      annotations: PURE,
    },
    tool((a) => jsonResult(call("WEB_PAGE", "/v1/markdown", { json: a }))),
  );

  server.registerTool(
    "get_link_preview",
    {
      title: "Link preview",
      description:
        "Get a link preview for a URL: title, description, canonical URL, images, favicon, site name, " +
        "Open Graph and Twitter card tags.",
      inputSchema: { url: z.string().url().describe("http(s) URL to preview") },
      annotations: READ_ONLY,
    },
    tool((a) => jsonResult(call("WEB_PAGE", "/v1/preview", { query: a }))),
  );

  // ---- OG Image API -------------------------------------------------------
  server.registerTool(
    "generate_og_image",
    {
      title: "Generate Open Graph image",
      description:
        "Render a 1200x630 PNG Open Graph (og:image) share image from a title, for link previews on X, " +
        "LinkedIn, Facebook, Slack and Discord. Returns the image.",
      inputSchema: {
        title: z.string().min(1).max(300).describe("Headline, wraps to up to 3 lines"),
        subtitle: z.string().max(300).optional().describe("Second line under the title"),
        theme: z.enum(["dark", "light", "mint"]).optional().describe("Colour theme (default dark)"),
        badge: z.string().max(24).optional().describe("Small label above the title, e.g. NEW or GUIDE"),
        footer: z.string().max(80).optional().describe("Bottom-left text, usually a domain"),
      },
      annotations: PURE,
    },
    tool(async (a) => {
      const res = await call("OG_IMAGE", "/v1/og", { query: a });
      const data = Buffer.from(await res.arrayBuffer()).toString("base64");
      return {
        content: [
          { type: "image" as const, data, mimeType: res.headers.get("content-type") || "image/png" },
          { type: "text" as const, text: `1200x630 PNG for "${a.title}".` },
        ],
      };
    }),
  );

  // ---- Job Posting Parser API ---------------------------------------------
  const posting = {
    title: z.string().min(1).max(300).describe("Job title exactly as posted"),
    location: z.string().max(500).optional().describe("Location as posted, e.g. 'Remote - US' or 'Hybrid (London)'"),
    description: z.string().max(50_000).optional().describe("Full job description, text or HTML; salary, skills and flags come from it"),
    company: z.string().max(200).optional().describe("Company name"),
  };

  server.registerTool(
    "parse_job_posting",
    {
      title: "Parse a job posting",
      description:
        "Parse a job ad into structured fields: normalized title, seniority, job function, remote type and " +
        "allowed regions, salary (min/max, currency, annualised), years of experience, skills and flags.",
      inputSchema: posting,
      annotations: PURE,
    },
    tool((a) => jsonResult(call("JOB_PARSER", "/v1/parse", { json: a }))),
  );

  server.registerTool(
    "parse_job_postings_batch",
    {
      title: "Parse job postings (batch)",
      description: "Parse 1 to 20 job postings in one call; results come back in the same order.",
      inputSchema: { postings: z.array(z.object(posting)).min(1).max(20) },
      annotations: PURE,
    },
    tool((a) => jsonResult(call("JOB_PARSER", "/v1/parse/batch", { json: a }))),
  );

  // ---- Resume Parser + Job Match API --------------------------------------
  server.registerTool(
    "parse_resume",
    {
      title: "Parse a resume / CV",
      description:
        "Parse a resume into structured JSON: contact details, current title, seniority, job function, " +
        "experience, education and skills. Give either the text or a local file path (PDF with a text " +
        "layer, DOCX or TXT, max 5 MB; no OCR). Nothing is stored.",
      inputSchema: {
        text: z.string().max(100_000).optional().describe("The resume as plain text"),
        file_path: z.string().optional().describe("Path to a local PDF, DOCX or TXT file"),
      },
      annotations: PURE,
    },
    tool(async (a) => {
      if (!!a.text === !!a.file_path) throw new ApiError("Give exactly one of text or file_path.");
      if (a.text) return jsonResult(call("RESUME_MATCH", "/v1/resume/parse", { json: { text: a.text } }));
      const bytes = await readFile(a.file_path!);
      if (bytes.length > 5 * 1024 * 1024) throw new ApiError("The file is larger than 5 MB.");
      const types: Record<string, string> = {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".txt": "text/plain",
      };
      const form = new FormData();
      const type = types[extname(a.file_path!).toLowerCase()] ?? "application/octet-stream";
      form.append("file", new Blob([bytes], { type }), basename(a.file_path!));
      return jsonResult(call("RESUME_MATCH", "/v1/resume/parse", { form }));
    }),
  );

  server.registerTool(
    "match_resume_to_job",
    {
      title: "Score a resume against a job",
      description:
        "Score how well a resume fits a job posting, 0-100, with a breakdown (skills, seniority, job " +
        "function, experience, location) and the matched and missing skills.",
      inputSchema: {
        resume: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .describe("The resume as plain text, or the JSON returned by parse_resume"),
        job: z.object(posting).describe("The job posting"),
      },
      annotations: PURE,
    },
    tool((a) => jsonResult(call("RESUME_MATCH", "/v1/match", { json: a }))),
  );

  // ---- Skill Rating API ---------------------------------------------------
  const algorithm = z
    .enum(["openskill", "glicko2", "elo", "custom"])
    .optional()
    .describe("openskill (default, Weng-Lin, for teams and free-for-alls), glicko2, elo, or custom (Club Points)");
  const params = z.record(z.string(), z.number()).optional().describe("Algorithm parameter overrides, e.g. {\"k\": 24} for Elo");
  const players = z
    .record(
      z.string(),
      z.object({
        mu: z.number(),
        sigma: z.number().min(0),
        games: z.number().int().min(0).optional(),
        extra: z.record(z.string(), z.number()).optional(),
      }),
    )
    .optional()
    .describe("Ratings from a previous rate_matches call, keyed by player id; unknown players start at the default");
  const teams = z.array(z.array(z.string().min(1).max(100)).min(1).max(8)).min(2).max(8);

  server.registerTool(
    "rate_matches",
    {
      title: "Rate match results",
      description:
        "Compute player skill ratings from match results with OpenSkill, Glicko-2 or Elo. Handles 1v1, " +
        "teams, free-for-alls and draws. Stateless: pass earlier ratings back in as players to continue.",
      inputSchema: {
        matches: z
          .array(
            z.object({
              teams: teams.describe("Each team is a list of player ids; singles: one id per team"),
              winner: z.number().int().min(0).optional().describe("Index of the winning team (default 0)"),
              ranks: z.array(z.number().int().min(0)).optional().describe("Finishing position per team, lower is better; equal = draw"),
              weight: z.number().min(0.1).max(3).optional(),
              timestamp: z.union([z.string(), z.number().int()]).optional(),
            }),
          )
          .min(1)
          .max(5000),
        algorithm,
        params,
        players,
      },
      annotations: PURE,
    },
    tool((a) => jsonResult(call("SKILL_RATING", "/rate", { json: a }))),
  );

  server.registerTool(
    "predict_match",
    {
      title: "Predict a matchup",
      description: "Predict each team's win probability and the match quality (how even it is) from current ratings.",
      inputSchema: { teams, algorithm, params, players },
      annotations: PURE,
    },
    tool((a) => jsonResult(call("SKILL_RATING", "/predict", { json: a }))),
  );

  server.registerTool(
    "list_rating_algorithms",
    {
      title: "List rating algorithms",
      description: "List the supported rating algorithms and their tunable parameters with defaults and ranges.",
      inputSchema: {},
      annotations: PURE,
    },
    tool(() => jsonResult(call("SKILL_RATING", "/algorithms"))),
  );

  // ---- China Hot Lists API ------------------------------------------------
  const board = z
    .enum(["douyin", "weibo", "toutiao", "baidu", "kuaishou", "bilibili"])
    .describe("Platform hot list: douyin, weibo, toutiao, baidu, kuaishou or bilibili (popular videos)");
  const boards = z
    .array(board)
    .min(1)
    .max(6)
    .optional()
    .describe("Which platforms to include (default: all)");
  const limit = z.number().int().min(1).max(50).optional().describe("Items per board (default 50 for one board, 20 for several)");
  const translate = z
    .boolean()
    .optional()
    .describe("Add English titles (title_en) and a topic category to each item (default true)");
  const joined = (b?: string[]) => (b?.length ? b.join(",") : undefined);

  server.registerTool(
    "china_hot_lists_boards",
    {
      title: "List China hot-list boards",
      description:
        "List the Chinese platform hot lists available (Douyin, Weibo, Toutiao, Baidu, Kuaishou, Bilibili) " +
        "with their names, update interval and whether the last fetch worked. Use it to see which boards " +
        "exist before calling china_hot_list or china_hot_lists_all.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    tool(() => jsonResult(call("HOT_LISTS", "/v1/boards"))),
  );

  server.registerTool(
    "china_hot_list",
    {
      title: "China hot list (one platform)",
      description:
        "Get the real-time hot search / trending list of one Chinese platform, e.g. the Weibo hot search " +
        "or Douyin hot list, with rank, original Chinese title, English translation, topic category, heat " +
        "and link. Use it for \"what is trending on Weibo right now\" or \"top Douyin topics today\".",
      inputSchema: { board, limit, translate },
      annotations: READ_ONLY,
    },
    tool(({ board, ...q }) => jsonResult(call("HOT_LISTS", `/v1/boards/${encodeURIComponent(board)}`, { query: q }))),
  );

  server.registerTool(
    "china_hot_lists_all",
    {
      title: "China hot lists (several platforms)",
      description:
        "Get the real-time hot lists of several Chinese platforms (Douyin, Weibo, Toutiao, Baidu, Kuaishou, " +
        "Bilibili) in one call, each item with an English translation and topic category. Use it to answer " +
        "\"what is trending in China right now\" or to brief someone on Chinese social media today.",
      inputSchema: { boards, limit, translate },
      annotations: READ_ONLY,
    },
    tool((a) => jsonResult(call("HOT_LISTS", "/v1/all", { query: { ...a, boards: joined(a.boards) } }))),
  );

  server.registerTool(
    "china_hot_lists_search",
    {
      title: "Search China hot lists",
      description:
        "Search the current Chinese hot lists for a keyword in Chinese or English (matches the original " +
        "title or its English translation, case-insensitive). Use it to check \"is X trending on Weibo\", " +
        "\"is anyone in China talking about our brand / Tesla / this news\" right now.",
      inputSchema: {
        q: z.string().min(1).max(100).describe("Keyword, Chinese or English, e.g. 特斯拉 or Tesla"),
        boards,
      },
      annotations: READ_ONLY,
    },
    tool((a) => jsonResult(call("HOT_LISTS", "/v1/search", { query: { ...a, boards: joined(a.boards) } }))),
  );

  server.registerTool(
    "china_trending_across_platforms",
    {
      title: "Trending across Chinese platforms",
      description:
        "Find topics trending on several Chinese platforms at once (e.g. both Weibo and Douyin), grouped, " +
        "with each platform's rank. Use it for \"what are the biggest stories in China right now\": a " +
        "topic on many boards matters more than one on a single list.",
      inputSchema: {
        min_boards: z.number().int().min(2).max(6).optional().describe("Minimum number of platforms a topic must be on (default 2)"),
      },
      annotations: READ_ONLY,
    },
    tool((a) => jsonResult(call("HOT_LISTS", "/v1/cross", { query: a }))),
  );

  return server;
}

