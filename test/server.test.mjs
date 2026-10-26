// Runs the built server over stdio against a local mock of the five APIs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const seen = [];
let mock, client;

async function start(env) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env }));
  return c;
}

before(async () => {
  mock = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.startsWith("/og/v1/og")) {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      if (req.url.startsWith("/web/v1/preview") && req.url.includes("bad")) {
        res.writeHead(422, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "invalid_url", message: "That URL is not allowed." } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  client = await start({
    ...process.env,
    RAPIDAPI_KEY: "test-key",
    OG_IMAGE_BASE_URL: `${base}/og`,
    WEB_PAGE_BASE_URL: `${base}/web`,
    JOB_PARSER_BASE_URL: `${base}/job`,
    RESUME_MATCH_BASE_URL: `${base}/resume`,
    SKILL_RATING_BASE_URL: `${base}/rating`,
  });
});

after(async () => {
  await client?.close();
  mock?.close();
});

const last = () => seen[seen.length - 1];
const json = (r) => JSON.parse(r.content[0].text);

test("lists all eleven tools with input schemas", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "fetch_url_as_markdown", "generate_og_image", "get_link_preview", "html_to_markdown",
    "list_rating_algorithms", "match_resume_to_job", "parse_job_posting", "parse_job_postings_batch",
    "parse_resume", "predict_match", "rate_matches",
  ]);
  for (const t of tools) assert.ok(t.description.length > 40, t.name);
});

test("markdown is a GET with query params and RapidAPI headers", async () => {
  const r = await client.callTool({ name: "fetch_url_as_markdown", arguments: { url: "https://example.com/a", include_links: true } });
  assert.equal(r.isError, undefined);
  assert.equal(last().method, "GET");
  assert.equal(last().url, "/web/v1/markdown?url=https%3A%2F%2Fexample.com%2Fa&include_links=true");
  assert.equal(last().headers["x-rapidapi-key"], "test-key");
  assert.equal(last().headers["x-rapidapi-host"], "web-page-api.p.rapidapi.com");
});

test("html_to_markdown posts JSON", async () => {
  await client.callTool({ name: "html_to_markdown", arguments: { html: "<h1>Hi</h1>" } });
  assert.equal(last().method, "POST");
  assert.equal(last().headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(last().body), { html: "<h1>Hi</h1>" });
});

test("API errors come back as readable tool errors", async () => {
  const r = await client.callTool({ name: "get_link_preview", arguments: { url: "https://bad.example" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /HTTP 422: That URL is not allowed\./);
});

test("og image returns image content", async () => {
  const r = await client.callTool({ name: "generate_og_image", arguments: { title: "Hello", theme: "mint" } });
  assert.equal(r.content[0].type, "image");
  assert.equal(r.content[0].mimeType, "image/png");
  assert.equal(Buffer.from(r.content[0].data, "base64").toString("hex"), PNG.toString("hex"));
  assert.equal(last().url, "/og/v1/og?title=Hello&theme=mint");
});

test("job parsing, single and batch", async () => {
  assert.equal(json(await client.callTool({ name: "parse_job_posting", arguments: { title: "Senior Engineer" } })).path, "/job/v1/parse");
  await client.callTool({ name: "parse_job_postings_batch", arguments: { postings: [{ title: "A" }, { title: "B" }] } });
  assert.equal(JSON.parse(last().body).postings.length, 2);
});

test("resume from text, from a file, and matching", async () => {
  await client.callTool({ name: "parse_resume", arguments: { text: "Jane Doe, engineer" } });
  assert.deepEqual(JSON.parse(last().body), { text: "Jane Doe, engineer" });

  const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
  const file = join(dir, "cv.txt");
  writeFileSync(file, "Jane Doe\nEngineer");
  await client.callTool({ name: "parse_resume", arguments: { file_path: file } });
  assert.match(last().headers["content-type"], /^multipart\/form-data/);
  assert.match(last().body, /filename="cv.txt"/);
  assert.match(last().body, /Jane Doe/);

  const both = await client.callTool({ name: "parse_resume", arguments: {} });
  assert.equal(both.isError, true);

  await client.callTool({ name: "match_resume_to_job", arguments: { resume: "Jane", job: { title: "Engineer" } } });
  assert.equal(last().url, "/resume/v1/match");
});

test("ratings tools", async () => {
  await client.callTool({ name: "rate_matches", arguments: { algorithm: "elo", matches: [{ teams: [["a"], ["b"]], winner: 1 }] } });
  assert.equal(last().url, "/rating/rate");
  assert.equal(JSON.parse(last().body).matches[0].winner, 1);
  await client.callTool({ name: "predict_match", arguments: { teams: [["a"], ["b"]] } });
  assert.equal(last().url, "/rating/predict");
  await client.callTool({ name: "list_rating_algorithms", arguments: {} });
  assert.equal(last().method, "GET");
});

test("missing RAPIDAPI_KEY explains how to get one", async () => {
  const env = { ...process.env };
  delete env.RAPIDAPI_KEY;
  const c = await start(env);
  try {
    const r = await c.callTool({ name: "get_link_preview", arguments: { url: "https://example.com" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /RAPIDAPI_KEY is not set.*web-page-api\.fly\.dev/);
  } finally {
    await c.close();
  }
});
