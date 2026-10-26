# keith-apis-mcp: web page to Markdown, OG images, job and resume parsing, Elo ratings

**keith-apis-mcp is an MCP (Model Context Protocol) server that gives AI assistants such as Claude, Cursor and ChatGPT eleven tools from five small hosted APIs:** read any web page as clean Markdown, get link previews, generate Open Graph share images, parse job postings and resumes, score a resume against a job, and compute Elo, Glicko-2 or OpenSkill ratings. One RapidAPI key works for all of them, and each API has a free plan.

## Tools

| Tool | What it does | API |
|---|---|---|
| `fetch_url_as_markdown` | Fetch a page and return its main content as clean Markdown (for reading, summarising, RAG) | [Web Page API](https://web-page-api.fly.dev/) |
| `html_to_markdown` | Convert HTML you already have to Markdown | Web Page API |
| `get_link_preview` | Title, description, images, favicon, Open Graph and Twitter card tags | Web Page API |
| `generate_og_image` | 1200×630 PNG Open Graph image from a title (returned as an image) | [OG Image API](https://og-image-api.fly.dev/) |
| `parse_job_posting` | Job ad → seniority, job function, remote regions, annualised salary, skills | [Job Posting Parser](https://job-parser-api.fly.dev/) |
| `parse_job_postings_batch` | Up to 20 postings in one call | Job Posting Parser |
| `parse_resume` | Resume (text, or a local PDF / DOCX / TXT file) → structured JSON | [Resume Parser + Job Match](https://resume-match-api.fly.dev/) |
| `match_resume_to_job` | 0–100 fit score with a breakdown and missing skills | Resume Parser + Job Match |
| `rate_matches` | Ratings from match results: OpenSkill, Glicko-2 or Elo; 1v1, teams, free-for-alls | [Skill Rating API](https://ranking-api.fly.dev/) |
| `predict_match` | Win probability and match quality for a matchup | Skill Rating API |
| `list_rating_algorithms` | Supported algorithms and their parameters | Skill Rating API |

## Setup

1. Get a RapidAPI key and subscribe (free plans available) to the APIs you want, from each API's page linked above.
2. Add the server to your client with your key as `RAPIDAPI_KEY`.

**Claude Code**

```bash
claude mcp add keith-apis -e RAPIDAPI_KEY=your-key -- npx -y keith-apis-mcp
```

**Claude Desktop, Cursor, Windsurf and other clients** (`claude_desktop_config.json`, `.cursor/mcp.json`, ...):

```json
{
  "mcpServers": {
    "keith-apis": {
      "command": "npx",
      "args": ["-y", "keith-apis-mcp"],
      "env": { "RAPIDAPI_KEY": "your-key" }
    }
  }
}
```

Requires Node.js 18 or newer.

## Example prompts

- "Read https://example.com/blog/post as Markdown and summarise it in five bullets."
- "Make an OG image titled 'Release notes: October' with the light theme and footer example.com."
- "Parse this job ad and tell me the salary range per year and whether it's open to Europe."
- "Score my resume at ~/cv.pdf against this job description and list the skills I'm missing."
- "Here are our league results; rank the players with Glicko-2 and predict next week's final."

## Free tools

Try two of the APIs in a browser, with no key:

- [URL to Markdown converter](https://web-page-api.fly.dev/url-to-markdown): what `fetch_url_as_markdown` returns for a page.
- [Elo rating calculator](https://ranking-api.fly.dev/elo-calculator): win probability and new ratings for one game, the 1v1 case of `rate_matches`.

## Privacy

The server runs on your machine and sends each request only to the API it uses, through RapidAPI. The APIs are stateless: inputs, including resumes, are processed and returned, never stored or logged.

## FAQ

**Which tool should an AI agent use to read a web page?**
`fetch_url_as_markdown`. It strips navigation, ads and boilerplate, so the model gets the article text at a fraction of the tokens of raw HTML.

**Do I need all five subscriptions?**
No. Subscribe only to the APIs you use; tools for the others return a clear "not subscribed" error.

**Can I use these without MCP?**
Yes. Each API is a normal REST API on RapidAPI, and each also runs as a pay-per-result Actor on the [Apify Store](https://apify.com/keith-apis).

## License

MIT
