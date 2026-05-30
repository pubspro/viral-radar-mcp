#!/usr/bin/env node
/**
 * viral-radar-mcp
 * Cross-platform viral content finder MCP server (research / read-only).
 *
 * Aggregates trending and viral posts from multiple social/news networks and
 * ranks them with a single, comparable "virality score" so results across
 * platforms can be compared directly.
 *
 * Supported sources at launch:
 *   - Reddit            (public JSON endpoints; no key required for read-only)
 *   - Hacker News       (Algolia HN Search API; no key required)
 *   - X / Twitter       (via twitterapi.io; requires TWITTERAPI_IO_KEY)
 *
 * This server is strictly read-only. It never posts, replies to, or modifies
 * anything on any platform. All API credentials are read from environment
 * variables and are never logged.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type Platform = "reddit" | "hackernews" | "x";

interface ViralPost {
  platform: Platform;
  id: string;
  title: string;
  url: string;
  author: string;
  /** Unix epoch seconds when the post was created. */
  createdAt: number;
  /** Primary engagement signal (upvotes, points, likes). */
  score: number;
  /** Secondary engagement signal (comments / replies). */
  comments: number;
  /** Normalized virality score, 0-100. */
  viralityScore: number;
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const TWITTERAPI_IO_KEY = process.env.TWITTERAPI_IO_KEY ?? "";
const USER_AGENT =
  process.env.VIRAL_RADAR_USER_AGENT ?? "viral-radar-mcp/0.1 (research tool)";
const DEFAULT_LIMIT = 15;

/* ------------------------------------------------------------------ */
/* Virality scoring                                                    */
/* ------------------------------------------------------------------ */

/**
 * Compute a 0-100 virality score from raw engagement.
 *
 * The score blends three normalized factors:
 *   - velocity:   engagement per hour since posting (rewards fast growth)
 *   - engagement: total weighted engagement (score + 2x comments)
 *   - recency:    decay so old posts rank lower even if highly engaged
 *
 * Values are squashed with log + tanh so a handful of mega-viral posts do
 * not flatten everything else, and the result is comparable across very
 * different platforms (Reddit upvotes vs HN points vs X likes).
 */
function computeViralityScore(
  score: number,
  comments: number,
  createdAt: number,
  now: number = Date.now() / 1000
): number {
  const ageHours = Math.max((now - createdAt) / 3600, 0.25);
  const weightedEngagement = Math.max(score, 0) + 2 * Math.max(comments, 0);

  const velocity = weightedEngagement / ageHours;

  // Log-squash each component into roughly 0-1.
  const velocityNorm = Math.tanh(Math.log10(velocity + 1) / 2.5);
  const engagementNorm = Math.tanh(Math.log10(weightedEngagement + 1) / 4);
  const recencyNorm = 1 / (1 + ageHours / 24); // half-life ~ 1 day

  const blended =
    0.5 * velocityNorm + 0.3 * engagementNorm + 0.2 * recencyNorm;

  return Math.round(blended * 1000) / 10; // one decimal place, 0-100
}

/* ------------------------------------------------------------------ */
/* Source: Reddit                                                      */
/* ------------------------------------------------------------------ */

async function fetchRedditSearch(
  query: string,
  limit: number
): Promise<ViralPost[]> {
  const url =
    "https://www.reddit.com/search.json?sort=hot&t=week&limit=" +
    encodeURIComponent(String(Math.min(limit, 50))) +
    "&q=" +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error("Reddit search failed: " + res.status);
  const data: any = await res.json();
  const children: any[] = data?.data?.children ?? [];
  return children.map((c) => mapRedditPost(c.data));
}

async function fetchRedditTrending(
  subreddit: string,
  limit: number
): Promise<ViralPost[]> {
  const sub = subreddit && subreddit.length ? subreddit : "all";
  const url =
    "https://www.reddit.com/r/" +
    encodeURIComponent(sub) +
    "/hot.json?limit=" +
    encodeURIComponent(String(Math.min(limit, 50)));
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error("Reddit trending failed: " + res.status);
  const data: any = await res.json();
  const children: any[] = data?.data?.children ?? [];
  return children.map((c) => mapRedditPost(c.data));
}

function mapRedditPost(p: any): ViralPost {
  const score = Number(p?.score ?? 0);
  const comments = Number(p?.num_comments ?? 0);
  const createdAt = Number(p?.created_utc ?? Date.now() / 1000);
  return {
    platform: "reddit",
    id: String(p?.id ?? ""),
    title: String(p?.title ?? "").slice(0, 300),
    url: "https://www.reddit.com" + String(p?.permalink ?? ""),
    author: String(p?.author ?? "unknown"),
    createdAt,
    score,
    comments,
    viralityScore: computeViralityScore(score, comments, createdAt),
  };
}

/* ------------------------------------------------------------------ */
/* Source: Hacker News (Algolia)                                       */
/* ------------------------------------------------------------------ */

async function fetchHackerNews(
  query: string,
  limit: number
): Promise<ViralPost[]> {
  const base = query
    ? "https://hn.algolia.com/api/v1/search?tags=story&query=" +
      encodeURIComponent(query)
    : "https://hn.algolia.com/api/v1/search?tags=front_page";
  const url = base + "&hitsPerPage=" + encodeURIComponent(String(Math.min(limit, 50)));
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error("Hacker News search failed: " + res.status);
  const data: any = await res.json();
  const hits: any[] = data?.hits ?? [];
  return hits.map((h) => {
    const score = Number(h?.points ?? 0);
    const comments = Number(h?.num_comments ?? 0);
    const createdAt = Number(h?.created_at_i ?? Date.now() / 1000);
    return {
      platform: "hackernews",
      id: String(h?.objectID ?? ""),
      title: String(h?.title ?? h?.story_title ?? "").slice(0, 300),
      url:
        String(h?.url ?? "") ||
        "https://news.ycombinator.com/item?id=" + String(h?.objectID ?? ""),
      author: String(h?.author ?? "unknown"),
      createdAt,
      score,
      comments,
      viralityScore: computeViralityScore(score, comments, createdAt),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Source: X / Twitter (twitterapi.io)                                 */
/* ------------------------------------------------------------------ */

async function fetchX(query: string, limit: number): Promise<ViralPost[]> {
  if (!TWITTERAPI_IO_KEY) {
    // No key configured: skip gracefully rather than failing the whole query.
    return [];
  }
  const url =
    "https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Top&query=" +
    encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { "X-API-Key": TWITTERAPI_IO_KEY, "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error("X (twitterapi.io) search failed: " + res.status);
  const data: any = await res.json();
  const tweets: any[] = data?.tweets ?? data?.data ?? [];
  return tweets.slice(0, limit).map((t) => {
    const score = Number(t?.likeCount ?? t?.favorite_count ?? 0);
    const comments = Number(t?.replyCount ?? t?.reply_count ?? 0);
    const createdRaw = t?.createdAt ?? t?.created_at;
    const createdAt = createdRaw
      ? Math.floor(new Date(createdRaw).getTime() / 1000)
      : Date.now() / 1000;
    const id = String(t?.id ?? t?.id_str ?? "");
    const handle = String(t?.author?.userName ?? t?.user?.screen_name ?? "unknown");
    return {
      platform: "x" as Platform,
      id,
      title: String(t?.text ?? t?.full_text ?? "").slice(0, 300),
      url: "https://x.com/" + handle + "/status/" + id,
      author: handle,
      createdAt,
      score,
      comments,
      viralityScore: computeViralityScore(score, comments, createdAt),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Aggregation helpers                                                 */
/* ------------------------------------------------------------------ */

const ALL_PLATFORMS: Platform[] = ["reddit", "hackernews", "x"];

function parsePlatforms(input: unknown): Platform[] {
  if (!Array.isArray(input) || input.length === 0) return ALL_PLATFORMS;
  const out = input
    .map((p) => String(p).toLowerCase())
    .filter((p): p is Platform => ALL_PLATFORMS.includes(p as Platform));
  return out.length ? out : ALL_PLATFORMS;
}

async function gatherByTopic(
  query: string,
  platforms: Platform[],
  perPlatform: number
): Promise<{ posts: ViralPost[]; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const jobs = platforms.map(async (p) => {
    try {
      if (p === "reddit") return await fetchRedditSearch(query, perPlatform);
      if (p === "hackernews") return await fetchHackerNews(query, perPlatform);
      if (p === "x") return await fetchX(query, perPlatform);
      return [];
    } catch (e: any) {
      errors[p] = e?.message ?? String(e);
      return [] as ViralPost[];
    }
  });
  const results = await Promise.all(jobs);
  const posts = results.flat().sort((a, b) => b.viralityScore - a.viralityScore);
  return { posts, errors };
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: "Error: " + message }],
  };
}

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: "find_viral_by_topic",
    description:
      "Find the top viral/trending posts about a topic across multiple platforms (Reddit, Hacker News, X). Returns a single ranked list ordered by a unified virality score. Read-only research.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic or keyword to search for." },
        platforms: {
          type: "array",
          items: { type: "string", enum: ALL_PLATFORMS },
          description: "Platforms to include. Defaults to all.",
        },
        limit: {
          type: "number",
          description: "Max posts to return overall (default 15).",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "get_trending_now",
    description:
      "Get what is trending right now on a given platform, independent of any topic. For Reddit you may pass a subreddit (default r/all); Hacker News returns the front page; X returns top recent tweets for the optional query.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ALL_PLATFORMS },
        subreddit: {
          type: "string",
          description: "Reddit only: subreddit name without 'r/'. Default 'all'.",
        },
        limit: { type: "number", description: "Max posts (default 15)." },
      },
      required: ["platform"],
    },
  },
  {
    name: "score_virality",
    description:
      "Compute the unified 0-100 virality score for a post given its engagement metrics. Useful to rank posts you already have. Blends velocity, total engagement, and recency.",
    inputSchema: {
      type: "object",
      properties: {
        score: { type: "number", description: "Upvotes/points/likes." },
        comments: { type: "number", description: "Comments/replies." },
        createdAt: {
          type: "number",
          description: "Unix epoch seconds when the post was created.",
        },
      },
      required: ["score", "comments", "createdAt"],
    },
  },
  {
    name: "compare_platforms",
    description:
      "Compare how viral a topic is across platforms right now. Returns, per platform, the post count, peak virality score, and average virality score so you can see where a topic is hottest.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic or keyword to compare." },
        platforms: {
          type: "array",
          items: { type: "string", enum: ALL_PLATFORMS },
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "analyze_post",
    description:
      "Fetch and analyze a single post's engagement and virality score from a Reddit or Hacker News id/url. (X analysis requires TWITTERAPI_IO_KEY.)",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ALL_PLATFORMS },
        id: {
          type: "string",
          description:
            "Reddit post id (e.g. 'abc123') or Hacker News story id. For X, the tweet id.",
        },
      },
      required: ["platform", "id"],
    },
  },
];

/* ------------------------------------------------------------------ */
/* Tool handlers                                                       */
/* ------------------------------------------------------------------ */

async function handleAnalyzePost(platform: Platform, id: string) {
  if (platform === "hackernews") {
    const res = await fetch("https://hn.algolia.com/api/v1/items/" + encodeURIComponent(id), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error("Hacker News item failed: " + res.status);
    const h: any = await res.json();
    const score = Number(h?.points ?? 0);
    const comments = Number(h?.children?.length ?? 0);
    const createdAt = Number(h?.created_at_i ?? Date.now() / 1000);
    return {
      platform,
      id: String(h?.id ?? id),
      title: String(h?.title ?? ""),
      url: String(h?.url ?? "https://news.ycombinator.com/item?id=" + id),
      author: String(h?.author ?? "unknown"),
      createdAt,
      score,
      comments,
      viralityScore: computeViralityScore(score, comments, createdAt),
    };
  }
  if (platform === "reddit") {
    const res = await fetch(
      "https://www.reddit.com/by_id/t3_" + encodeURIComponent(id) + ".json",
      { headers: { "User-Agent": USER_AGENT } }
    );
    if (!res.ok) throw new Error("Reddit item failed: " + res.status);
    const data: any = await res.json();
    const p = data?.data?.children?.[0]?.data;
    if (!p) throw new Error("Reddit post not found: " + id);
    return mapRedditPost(p);
  }
  // X
  const results = await fetchX("", 1);
  throw new Error(
    "Single-post X analysis is not supported in v1" +
      (results ? "" : "") +
      "; use find_viral_by_topic for X."
  );
}

/* ------------------------------------------------------------------ */
/* Server wiring                                                       */
/* ------------------------------------------------------------------ */

const server = new Server(
  { name: "viral-radar-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    if (name === "find_viral_by_topic") {
      const topic = String(args.topic ?? "").trim();
      if (!topic) return fail("'topic' is required.");
      const platforms = parsePlatforms(args.platforms);
      const limit = Number(args.limit ?? DEFAULT_LIMIT);
      const perPlatform = Math.max(5, Math.ceil(limit / platforms.length) + 3);
      const { posts, errors } = await gatherByTopic(topic, platforms, perPlatform);
      return ok({
        topic,
        platforms,
        count: Math.min(posts.length, limit),
        results: posts.slice(0, limit),
        errors: Object.keys(errors).length ? errors : undefined,
      });
    }

    if (name === "get_trending_now") {
      const platform = String(args.platform ?? "") as Platform;
      const limit = Number(args.limit ?? DEFAULT_LIMIT);
      if (!ALL_PLATFORMS.includes(platform)) return fail("Unknown platform.");
      let posts: ViralPost[] = [];
      if (platform === "reddit") {
        posts = await fetchRedditTrending(String(args.subreddit ?? "all"), limit);
      } else if (platform === "hackernews") {
        posts = await fetchHackerNews("", limit);
      } else {
        posts = await fetchX(String(args.subreddit ?? "trending"), limit);
      }
      posts.sort((a, b) => b.viralityScore - a.viralityScore);
      return ok({ platform, count: posts.length, results: posts.slice(0, limit) });
    }

    if (name === "score_virality") {
      const score = Number(args.score ?? 0);
      const comments = Number(args.comments ?? 0);
      const createdAt = Number(args.createdAt ?? Date.now() / 1000);
      const viralityScore = computeViralityScore(score, comments, createdAt);
      return ok({
        score,
        comments,
        createdAt,
        viralityScore,
        scale: "0-100 (higher = more viral right now)",
      });
    }

    if (name === "compare_platforms") {
      const topic = String(args.topic ?? "").trim();
      if (!topic) return fail("'topic' is required.");
      const platforms = parsePlatforms(args.platforms);
      const { posts, errors } = await gatherByTopic(topic, platforms, 15);
      const summary = platforms.map((p) => {
        const subset = posts.filter((x) => x.platform === p);
        const peak = subset.reduce((m, x) => Math.max(m, x.viralityScore), 0);
        const avg =
          subset.length > 0
            ? Math.round(
                (subset.reduce((s, x) => s + x.viralityScore, 0) / subset.length) * 10
              ) / 10
            : 0;
        return { platform: p, postCount: subset.length, peakVirality: peak, avgVirality: avg };
      });
      summary.sort((a, b) => b.peakVirality - a.peakVirality);
      return ok({
        topic,
        comparison: summary,
        hottestPlatform: summary[0]?.platform ?? null,
        errors: Object.keys(errors).length ? errors : undefined,
      });
    }

    if (name === "analyze_post") {
      const platform = String(args.platform ?? "") as Platform;
      const id = String(args.id ?? "").trim();
      if (!ALL_PLATFORMS.includes(platform)) return fail("Unknown platform.");
      if (!id) return fail("'id' is required.");
      const post = await handleAnalyzePost(platform, id);
      return ok(post);
    }

    return fail("Unknown tool: " + name);
  } catch (e: any) {
    return fail(e?.message ?? String(e));
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error("viral-radar-mcp running on stdio");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting viral-radar-mcp:", err);
  process.exit(1);
});
