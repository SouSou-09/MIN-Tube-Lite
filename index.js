const express = require("express");
const path = require("path");
const yts = require("youtube-search-api");
const fetch = require("node-fetch");
const cookieParser = require("cookie-parser");
const https = require("https");
const fs = require('fs');
const compression = require("compression");

const app = express();
const port = process.env.PORT || 3000;

// ──────────────────────────────────────────────────────────────────────────
// パフォーマンス最適化
//  - gzip/deflate 圧縮で転送量を削減
//  - ETag を有効化 (デフォルト ON だが明示)
//  - x-powered-by ヘッダを無効化 (微小な節約)
// ──────────────────────────────────────────────────────────────────────────
app.disable('x-powered-by');
app.set('etag', 'strong');
app.use(compression({
  level: 6,            // 圧縮率と CPU のバランス
  threshold: 1024,     // 1KB 未満は圧縮しない
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

const API_HEALTH_CHECKER = "https://raw.githubusercontent.com/Minotaur-ZAOU/test/refs/heads/main/min-tube-api.json";
const TEMP_API_LIST = "https://raw.githubusercontent.com/Minotaur-ZAOU/test/refs/heads/main/min-tube-api.json";
const RAPID_API_HOST = 'ytstream-download-youtube-videos.p.rapidapi.com';
const videoCache = new Map();
const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0"
];

const keys = [
  process.env.RAPIDAPI_KEY_1 || '69e2995a79mshcb657184ba6731cp16f684jsn32054a070ba5',
  process.env.RAPIDAPI_KEY_2 || 'ece95806fdmshe322f47bce30060p1c3411jsn41a3d4820039',
  process.env.RAPIDAPI_KEY_3 || '41c9265bc6msha0fa7dfc1a63eabp18bf7cjsne6ef10b79b38'
];

// 静的ファイル配信: ブラウザキャッシュを有効化して再読み込みを高速化
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: '7d',         // 画像/CSS/JS は 7 日キャッシュ
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // HTML は短めに (更新を反映しやすくする)
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    } else if (/\.(?:css|js|woff2?|ttf|eot|png|jpe?g|gif|webp|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  }
}));
// img ディレクトリも長期キャッシュ
app.use('/img', express.static(path.join(__dirname, 'img'), {
  maxAge: '30d',
  immutable: true,
}));
app.use(cookieParser());

let apiListCache = [];

async function updateApiListCache() {
  try {
    const response = await fetch(API_HEALTH_CHECKER);
    if (response.ok) {
      const mainApiList = await response.json();
      if (Array.isArray(mainApiList) && mainApiList.length > 0) {
        apiListCache = mainApiList;
        console.log("API List updated.");
      }
    }
  } catch (err) {
    console.error("API update failed.");
  }
}

updateApiListCache();
setInterval(updateApiListCache, 1000 * 60 * 10);

function fetchWithTimeout(url, options = {}, timeout = 5000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
    )
  ]);
}

// ──────────────────────────────────────────────────────────────────────────
// v1.3.0: 動画一覧ページにチャンネルの画像が表示されないバグの修正用ヘルパー
//
// youtube-search-api (yts) は videoRenderer から channelThumbnail を取り出さない
// ため、フロントエンドでは常に ui-avatars の代替アイコン（簡易表示）が出ていた。
// ここで生の YouTube 検索ページから videoRenderer を直接パースし、
// {id, channelThumbnail, channelId, viewCountText, publishedTimeText} を抽出する。
// 取得結果は短時間キャッシュして API レート/レイテンシ影響を抑える。
// ──────────────────────────────────────────────────────────────────────────
const channelMetaCache = new Map(); // key: videoId -> {channelThumbnail, channelId, viewCountText, publishedTimeText, expiry}
const channelMetaQueryCache = new Map(); // key: query -> {expiry, map(videoId->meta)}

function pickThumbUrl(thumbObj) {
  try {
    if (!thumbObj) return '';
    if (Array.isArray(thumbObj)) {
      return thumbObj[thumbObj.length - 1]?.url || '';
    }
    if (thumbObj.thumbnails && Array.isArray(thumbObj.thumbnails)) {
      const arr = thumbObj.thumbnails;
      return arr[arr.length - 1]?.url || '';
    }
    if (typeof thumbObj === 'string') return thumbObj;
  } catch (e) {}
  return '';
}

function extractVideoMetaFromRenderer(vr) {
  if (!vr || !vr.videoId) return null;
  const channelThumbObj =
    vr.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail ||
    vr.channelThumbnail;
  let channelThumbnail = pickThumbUrl(channelThumbObj);
  if (channelThumbnail && channelThumbnail.startsWith('//')) channelThumbnail = 'https:' + channelThumbnail;

  const ownerRun = vr.ownerText?.runs?.[0] || vr.shortBylineText?.runs?.[0] || null;
  const channelId =
    ownerRun?.navigationEndpoint?.browseEndpoint?.browseId ||
    vr.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
    '';

  const viewCountText =
    vr.viewCountText?.simpleText ||
    (vr.viewCountText?.runs ? vr.viewCountText.runs.map(r => r.text).join('') : '') ||
    vr.shortViewCountText?.simpleText ||
    '';
  const publishedTimeText = vr.publishedTimeText?.simpleText || '';

  return {
    id: vr.videoId,
    channelThumbnail,
    channelId,
    viewCountText,
    publishedTimeText
  };
}

async function fetchYouTubeSearchMeta(query) {
  const cached = channelMetaQueryCache.get(query);
  if (cached && cached.expiry > Date.now()) return cached.map;

  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=ja&gl=JP`;
  const headers = {
    'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
    'Accept-Language': 'ja,en;q=0.8'
  };
  const map = new Map();
  try {
    const r = await fetchWithTimeout(url, { headers }, 4000);
    if (!r.ok) return map;
    const html = await r.text();
    const idx = html.indexOf('var ytInitialData =');
    if (idx === -1) return map;
    const after = html.slice(idx + 'var ytInitialData ='.length);
    // 終端を慎重に探す（最後に "</script>" が来る最初の位置）
    const end = after.indexOf('</script>');
    if (end === -1) return map;
    let jsonText = after.slice(0, end).trim();
    if (jsonText.endsWith(';')) jsonText = jsonText.slice(0, -1);
    let data;
    try { data = JSON.parse(jsonText); } catch (e) { return map; }

    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    for (const sec of sections) {
      const items = sec?.itemSectionRenderer?.contents || [];
      for (const it of items) {
        if (it.videoRenderer) {
          const meta = extractVideoMetaFromRenderer(it.videoRenderer);
          if (meta) {
            map.set(meta.id, meta);
            channelMetaCache.set(meta.id, { ...meta, expiry: Date.now() + 30 * 60 * 1000 });
          }
        }
      }
    }
  } catch (e) {
    // 失敗時は空マップを返す（フロント側で ui-avatars フォールバックされる）
  }
  channelMetaQueryCache.set(query, { expiry: Date.now() + 5 * 60 * 1000, map });
  return map;
}

// yts の検索結果に channelThumbnail / channelId / viewCountText / publishedTimeText を上書き付与する
async function enrichItemsWithChannelMeta(items, query) {
  if (!Array.isArray(items) || items.length === 0) return items;
  let metaMap;
  try {
    metaMap = await fetchYouTubeSearchMeta(query);
  } catch (e) { metaMap = new Map(); }

  for (const it of items) {
    if (!it || it.type !== 'video' || !it.id) continue;
    let meta = metaMap.get(it.id);
    if (!meta) {
      const cached = channelMetaCache.get(it.id);
      if (cached && cached.expiry > Date.now()) meta = cached;
    }
    if (!meta) continue;
    if (meta.channelThumbnail && !it.channelThumbnail) it.channelThumbnail = meta.channelThumbnail;
    if (meta.channelId && !it.channelId) it.channelId = meta.channelId;
    if (meta.viewCountText && !it.viewCountText) it.viewCountText = meta.viewCountText;
    if (meta.publishedTimeText && !it.publishedTimeText) it.publishedTimeText = meta.publishedTimeText;
  }
  return items;
}

setInterval(() => {
    const now = Date.now();
    for (const [videoId, cachedItem] of videoCache.entries()) {
        if (cachedItem.expiry < now) {
            videoCache.delete(videoId);
        }
    }
}, 300000);

// ──────────────────────────────────────────────────────────────────────────
// v1.4.0: APIレスポンスキャッシュ
//  - 人気動画 / 検索 / 関連動画 のレスポンスを TTL 付きでキャッシュ
//  - YouTube バックエンドへの問い合わせ回数を削減し、体感速度・コストを改善
//  - Redis が使える環境 (REDIS_URL が設定されている) なら Redis を優先し、
//    無ければ自動でメモリキャッシュにフォールバック
//  - LRU 風: 上限サイズに達したら最も古いキーを削除
// ──────────────────────────────────────────────────────────────────────────
const RESPONSE_CACHE_MAX = 500;
const responseCacheMem = new Map(); // key -> { expiry, payload }

// Redis (任意)。redis モジュールが入っていれば利用する。
let redisClient = null;
(async () => {
  if (!process.env.REDIS_URL) return;
  try {
    // 動的 require: redis 未インストールでも他機能に影響を出さない
    const redisLib = require('redis');
    redisClient = redisLib.createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (e) => console.warn('[cache] Redis error:', e.message));
    await redisClient.connect();
    console.log('[cache] Redis connected for response cache');
  } catch (e) {
    redisClient = null;
    console.log('[cache] Redis not available, using in-memory cache');
  }
})();

async function cacheGet(key) {
  if (redisClient) {
    try {
      const v = await redisClient.get(key);
      if (v) return JSON.parse(v);
    } catch (e) { /* fallthrough */ }
  }
  const entry = responseCacheMem.get(key);
  if (!entry) return null;
  if (entry.expiry < Date.now()) {
    responseCacheMem.delete(key);
    return null;
  }
  // LRU: 最近アクセスされたキーを末尾に移動
  responseCacheMem.delete(key);
  responseCacheMem.set(key, entry);
  return entry.payload;
}

async function cacheSet(key, payload, ttlMs) {
  if (redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(payload), { PX: ttlMs });
    } catch (e) { /* ignore */ }
  }
  responseCacheMem.set(key, { expiry: Date.now() + ttlMs, payload });
  // メモリ上限の制御
  if (responseCacheMem.size > RESPONSE_CACHE_MAX) {
    const oldestKey = responseCacheMem.keys().next().value;
    if (oldestKey) responseCacheMem.delete(oldestKey);
  }
}

// 期限切れエントリの定期掃除
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of responseCacheMem.entries()) {
    if (v.expiry < now) responseCacheMem.delete(k);
  }
}, 5 * 60 * 1000);

// レスポンスキャッシュ統計用 (デバッグ・運用確認用)
const cacheStats = { hit: 0, miss: 0 };
app.get('/api/_cache-stats', (req, res) => {
  res.json({
    backend: redisClient ? 'redis+memory' : 'memory',
    memorySize: responseCacheMem.size,
    memoryLimit: RESPONSE_CACHE_MAX,
    hit: cacheStats.hit,
    miss: cacheStats.miss,
    hitRate: cacheStats.hit + cacheStats.miss === 0
      ? 0
      : +(cacheStats.hit / (cacheStats.hit + cacheStats.miss) * 100).toFixed(2)
  });
});

// v1.3.0: MinTubeでの偽装ページ/ローディング表示を削除（人間確認ミドルウェア廃止）。
// 旧仕様では humanVerified Cookie が無い場合に robots テンプレートで
// ダミーの「読み込み中ページ」「reCAPTCHA 風の確認ページ」を返していたが、
// ユーザー体験を損なうため完全に取り除き、リクエストはそのまま処理する。

// --- API ENDPOINTS ---

// HTML 用の軽量キャッシュ (5 分間) — ナビゲーションを高速化
const htmlCacheHeaders = (res) => {
  res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
};

// ──────────────────────────────────────────────────────────────────────────
// v1.4.0: おすすめ／関連動画の関連性スコアリング
//  - これまでは検索結果を単純に結合・シャッフルしていたため、無関係な動画が
//    多数混ざっていた。元動画のタイトル／チャンネルとの一致度でスコアを付け、
//    関連性が低いものを除外・後ろに回すことで精度を改善する。
// ──────────────────────────────────────────────────────────────────────────

// 日本語・英数字に対応した簡易トークナイザ
//  - 英数字の連なり、ひらがな/カタカナ/漢字の連なりをそれぞれ語として抽出
const STOPWORDS = new Set([
  'official','video','music','mv','lyrics','feat','ver','full','hd','4k',
  'the','and','for','you','your','with','from','this','that',
  '公式','動画','実況','解説','まとめ','最新','人気','話題','チャンネル',
  'live','ライブ','配信','part','epi','episode','season'
]);

function tokenizeForRelevance(str) {
  if (!str) return [];
  const lowered = String(str).toLowerCase();
  // 記号をスペースに、英数字塊・日本語塊を抽出
  const matches = lowered.match(/[a-z0-9]+|[\u3040-\u30ff\u4e00-\u9faf]+/g) || [];
  const tokens = [];
  for (const m of matches) {
    // 英数字は 2 文字以上、日本語は 2 文字以上を採用
    if (/^[a-z0-9]+$/.test(m)) {
      if (m.length >= 2 && !STOPWORDS.has(m)) tokens.push(m);
    } else {
      if (m.length >= 2 && !STOPWORDS.has(m)) {
        tokens.push(m);
        // 日本語は連続2文字のバイグラムにも分解（部分一致を取りやすくする）
        for (let i = 0; i + 2 <= m.length; i++) {
          const bi = m.slice(i, i + 2);
          if (!STOPWORDS.has(bi)) tokens.push(bi);
        }
      }
    }
  }
  return tokens;
}

// 元動画の {title, channel} に対して候補アイテムの関連スコアを算出
function relevanceScore(item, refTokenSet, refChannelLower) {
  if (!item || !item.title) return 0;
  const titleTokens = tokenizeForRelevance(item.title);
  if (titleTokens.length === 0) return 0;

  let overlap = 0;
  const counted = new Set();
  for (const t of titleTokens) {
    if (counted.has(t)) continue;
    if (refTokenSet.has(t)) { overlap++; counted.add(t); }
  }
  // 共通トークン比率（候補タイトルのうちどれだけ元動画と被るか）
  let score = overlap;

  // 同一チャンネルは強めにブースト
  const ch = (item.channelTitle || item.channelName || '').toLowerCase();
  if (refChannelLower && ch && (ch === refChannelLower || ch.includes(refChannelLower) || refChannelLower.includes(ch))) {
    score += 3;
  }
  return score;
}

// スコアでフィルタ・並べ替え（関連性が低いものを除外）
function rankByRelevance(items, refTitle, refChannel, { minScore = 1, limit = 24 } = {}) {
  const refTokens = new Set(tokenizeForRelevance(refTitle));
  const refChannelLower = (refChannel || '').toLowerCase();
  const scored = [];
  for (const it of items) {
    const s = relevanceScore(it, refTokens, refChannelLower);
    scored.push({ it, s });
  }
  // スコア >= minScore を関連動画として優先採用
  const relevant = scored.filter(x => x.s >= minScore).sort((a, b) => b.s - a.s);
  const result = relevant.map(x => x.it).slice(0, limit);
  return result;
}

app.get("/", (req, res) => {
  htmlCacheHeaders(res);
  res.sendFile(path.join(__dirname, "public", "min-tube-lite.html"));
});

app.get("/home", (req, res) => {
  htmlCacheHeaders(res);
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

app.get("/api/trending", async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const cacheKey = `trending:p${page}`;
  // 人気動画は変動が比較的緩やか -> 10 分キャッシュ
  const cached = await cacheGet(cacheKey);
  if (cached) {
    cacheStats.hit++;
    res.setHeader('X-Cache', 'HIT');
    // クライアントブラウザにも短期キャッシュを許可
    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.json(cached);
  }
  cacheStats.miss++;
  try {
    const trendingSeeds = [
      "人気急上昇", "最新 ニュース", "Music Video Official", 
      "ゲーム実況 人気", "話題の動画", "トレンド", 
      "Breaking News Japan", "Top Hits", "いま話題"
    ];

    const seed1 = trendingSeeds[(page * 2) % trendingSeeds.length];
    const seed2 = trendingSeeds[(page * 2 + 1) % trendingSeeds.length];

    const [res1, res2] = await Promise.all([
      yts.GetListByKeyword(seed1, false, 25),
      yts.GetListByKeyword(seed2, false, 25)
    ]);

    let combined = [...(res1.items || []), ...(res2.items || [])];

    // v1.3.0: 各シード結果に channelThumbnail などを付与（チャンネル画像が表示されないバグ修正）
    await Promise.all([
      enrichItemsWithChannelMeta(res1.items || [], seed1),
      enrichItemsWithChannelMeta(res2.items || [], seed2)
    ]);

    const finalItems = [];
    const seenIdsServer = new Set();

    for (const item of combined) {
      if (item.type === 'video' && !seenIdsServer.has(item.id)) {
        if (item.viewCountText) {
          seenIdsServer.add(item.id);
          finalItems.push(item);
        }
      }
    }

    const result = finalItems.sort(() => 0.5 - Math.random());
    const payload = { items: result };
    // 10 分キャッシュ
    await cacheSet(cacheKey, payload, 10 * 60 * 1000);
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.json(payload);

  } catch (err) {
    console.error("Trending API Error:", err);
    res.json({ items: [] });
  }
});


// ──────────────────────────────────────────────────────────────────────────
// v1.3.3: 検索高速化 — Study2525 (2525) を並列バックエンドとして再導入
//  - youtube-search-api と Study2525 (Invidious 互換) に対して同時にリクエスト
//  - 先に返って来た方を Promise.race で即時レスポンス（体感速度を最大化）
//  - 後発の結果はバックグラウンドでマージしキャッシュに蓄積
//  - どちらか片方が落ちていても継続動作（耐障害性）
// ──────────────────────────────────────────────────────────────────────────
const STUDY2525_BASES = [
  'https://study2525.glitch.me',
  'https://yt.chocolatemoo53.com'
];

// Study2525 / Invidious 互換 API のレスポンスを yts 形式に正規化
function normalizeStudy2525Items(data) {
  if (!Array.isArray(data)) return [];
  return data.map(it => {
    if (!it) return null;
    const type = it.type || (it.videoId ? 'video' : it.playlistId ? 'playlist' : it.authorId ? 'channel' : null);
    if (type === 'video' && it.videoId) {
      const thumbs = Array.isArray(it.videoThumbnails) && it.videoThumbnails.length
        ? it.videoThumbnails
        : [{ url: `https://i.ytimg.com/vi/${it.videoId}/mqdefault.jpg` }];
      const lenSec = Number(it.lengthSeconds) || 0;
      const lengthText = lenSec > 0
        ? `${Math.floor(lenSec / 60)}:${String(lenSec % 60).padStart(2, '0')}`
        : '';
      return {
        id: it.videoId,
        type: 'video',
        title: it.title || '',
        channelTitle: it.author || '',
        channelId: it.authorId || '',
        author: { name: it.author || '', channelId: it.authorId || '' },
        thumbnail: { thumbnails: thumbs },
        length: { simpleText: lengthText },
        lengthText,
        viewCount: it.viewCount || 0,
        viewCountText: it.viewCount
          ? `${Number(it.viewCount).toLocaleString()} 回視聴`
          : '',
        publishedTimeText: it.publishedText || '',
        _source: 'study2525'
      };
    }
    if (type === 'channel' && it.authorId) {
      return {
        id: it.authorId,
        type: 'channel',
        title: it.author || '',
        channelTitle: it.author || '',
        thumbnail: { thumbnails: it.authorThumbnails || [] },
        subCount: it.subCount || 0,
        subCountText: it.subCountText || '',
        videoCount: it.videoCount || 0,
        description: it.description || '',
        _source: 'study2525'
      };
    }
    if (type === 'playlist' && it.playlistId) {
      return {
        id: it.playlistId,
        type: 'playlist',
        title: it.title || '',
        channelTitle: it.author || '',
        channelId: it.authorId || '',
        thumbnail: { thumbnails: it.playlistThumbnail ? [{ url: it.playlistThumbnail }] : [] },
        videoCount: it.videoCount || 0,
        length: it.videoCount || 0,
        _source: 'study2525'
      };
    }
    return null;
  }).filter(Boolean);
}

// Study2525 で検索（複数ミラーをフォールバック付きで試す）
async function searchViaStudy2525(query, page = 0, timeoutMs = 3500) {
  for (const base of STUDY2525_BASES) {
    try {
      const url = `${base}/api/v1/search?q=${encodeURIComponent(query)}&page=${parseInt(page) + 1}`;
      const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 MIN-Tube-Lite/1.3.3' } }, timeoutMs);
      if (!r.ok) continue;
      const data = await r.json().catch(() => null);
      const items = normalizeStudy2525Items(data);
      if (items.length) return items;
    } catch (e) { /* 次のミラーへ */ }
  }
  return [];
}

// 2 ソースを id + type で重複排除しつつマージ
function mergeSearchResults(primary, secondary) {
  const seen = new Set();
  const out = [];
  for (const list of [primary, secondary]) {
    for (const it of list) {
      if (!it) continue;
      const id = (typeof it.id === 'string') ? it.id : (it.id && it.id.videoId) || '';
      if (!id) continue;
      const key = (it.type || 'video') + ':' + id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

app.get("/api/search", async (req, res, next) => {
  const rawQuery = String(req.query.q || '');
  // 装飾記号は上流検索の精度を下げるので取り除く（全部消えた場合は元のクエリを使う）
  const query = rawQuery.replace(/[【】「」『』()（）\[\]<>＜＞]/g, ' ').replace(/\s+/g, ' ').trim() || rawQuery.trim();
  const page = parseInt(req.query.page) || 0;
  if (!query) return res.status(400).json({ error: "Query required" });

  const cacheKey = `search:${query.toLowerCase()}:p${page}`;
  // 検索結果は 5 分キャッシュ (同じクエリの連続検索/ページネーションで API コール削減)
  const cached = await cacheGet(cacheKey);
  if (cached) {
    cacheStats.hit++;
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json(cached);
  }
  cacheStats.miss++;

  try {
    // === 並列リクエスト ===
    // yts (メイン: 高品質だがやや低速) と Study2525 (2525: 軽量・キャッシュ済みで高速) を同時起動
    const ytsPromise = yts.GetListByKeyword(query, true, 25, page)
      .then(r => ({ source: 'yts', items: (r && r.items) || [], nextPage: r ? r.nextPage : null }))
      .catch(() => ({ source: 'yts', items: [], nextPage: null }));

    // Study2525 は page 0 でのみ並列起動 (ページネーションは yts に統一して整合性を保つ)
    const s2525Promise = page === 0
      ? searchViaStudy2525(query, page, 3500).then(items => ({ source: 'study2525', items, nextPage: null }))
      : Promise.resolve({ source: 'study2525', items: [], nextPage: null });

    // どちらか早い方を採用するための race。ただし「空配列で勝つ」のは避ける
    const raceWithMinItems = (promises, minItems = 1) =>
      new Promise((resolve) => {
        let pending = promises.length;
        let fallback = null;
        promises.forEach(p => p.then(v => {
          if (v && v.items && v.items.length >= minItems) {
            resolve(v);
          } else {
            fallback = fallback || v;
            if (--pending === 0) resolve(fallback || { items: [], nextPage: null });
          }
        }).catch(() => {
          if (--pending === 0) resolve(fallback || { items: [], nextPage: null });
        }));
      });

    const winner = await raceWithMinItems([ytsPromise, s2525Promise], 5);

    // 勝者の結果を即時レスポンス（高速化のキモ）
    // タイトル無し・サムネイル無しの壊れた結果は除外
    let items = (winner.items || []).filter(it => {
      if (!it || !it.title) return false;
      const hasThumb = (it.thumbnail && Array.isArray(it.thumbnail.thumbnails) && it.thumbnail.thumbnails.length > 0) || !!it.thumbnailUrl;
      return hasThumb || (it.type && it.type !== 'video');
    });
    let nextPage = winner.nextPage;

    // チャンネル画像補完（タイムアウト短め・失敗は無視）
    try { await enrichItemsWithChannelMeta(items, query); } catch (e) {}

    const payload = { items, nextPage };
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Source', winner.source || 'unknown');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(payload);

    // === バックグラウンドで遅れたソースをマージしてキャッシュ更新 ===
    // 同一クエリの次回アクセスはより豊富なデータでヒットさせる
    Promise.allSettled([ytsPromise, s2525Promise]).then(async (settled) => {
      const ytsItems = settled[0].status === 'fulfilled' ? (settled[0].value.items || []) : [];
      const s2525Items = settled[1].status === 'fulfilled' ? (settled[1].value.items || []) : [];
      const finalNext = settled[0].status === 'fulfilled' ? settled[0].value.nextPage : null;
      // yts を優先（メタデータが豊富なため）、Study2525 を補完として後ろに付ける
      const merged = mergeSearchResults(ytsItems, s2525Items);
      try { await enrichItemsWithChannelMeta(merged, query); } catch (e) {}
      await cacheSet(cacheKey, { items: merged, nextPage: finalNext }, 5 * 60 * 1000);
    });
  } catch (err) { next(err); }
});


// ── プレイリスト ──
app.get('/api/playlist/:id', async (req, res) => {
  const playlistId = req.params.id;
  const cacheKey = `playlist:${playlistId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    cacheStats.hit++;
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(cached);
  }
  cacheStats.miss++;
  try {
    const result = await yts.GetPlaylistData(playlistId, 100);
    // プレイリスト内容は比較的安定 -> 30 分キャッシュ
    await cacheSet(cacheKey, result, 30 * 60 * 1000);
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(result);
  } catch (e) {
    res.json({ items: [], metadata: {} });
  }
});

// ── 自動プレイリスト生成 (ジャンル / キーワードから) ──
// クエリ: ?q=キーワード&limit=20
// 複数キーワード対応: q="Music, ロック" のようにカンマ区切りで複数指定可
app.get('/api/auto-playlist', async (req, res) => {
  const raw = (req.query.q || '').toString().trim();
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 20));
  if (!raw) return res.status(400).json({ error: 'q (キーワード) が必要です', items: [] });

  // カンマ・読点・改行などで複数キーワードに分割
  const keywords = raw.split(/[,、\n]+/).map(s => s.trim()).filter(Boolean).slice(0, 5);
  const perKw = Math.ceil(limit / keywords.length) + 5;

  try {
    const results = await Promise.all(
      keywords.map(kw =>
        yts.GetListByKeyword(kw, false, perKw).catch(() => ({ items: [] }))
      )
    );

    // 動画のみ抽出 + 重複排除
    const seen = new Set();
    const merged = [];
    // ラウンドロビン的に各キーワードから 1 件ずつ取って混ぜる
    const max = Math.max(...results.map(r => (r.items || []).length));
    for (let i = 0; i < max && merged.length < limit; i++) {
      for (let k = 0; k < results.length && merged.length < limit; k++) {
        const it = (results[k].items || [])[i];
        if (!it) continue;
        if (it.type !== 'video') continue;
        const vid = typeof it.id === 'string' ? it.id : (it.id && it.id.videoId);
        if (!vid || seen.has(vid)) continue;
        seen.add(vid);

        // フロント側で扱いやすい形に正規化
        let thumb = '';
        if (Array.isArray(it.thumbnail)) thumb = it.thumbnail[it.thumbnail.length - 1]?.url || '';
        else if (it.thumbnail && it.thumbnail.thumbnails) thumb = it.thumbnail.thumbnails[it.thumbnail.thumbnails.length - 1]?.url || '';
        if (!thumb) thumb = `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`;

        merged.push({
          id: vid,
          title: it.title || '',
          channel: it.channelTitle || it.shortBylineText || '',
          channelId: it.channelId || '',
          thumbnail: thumb,
          length: it.length && it.length.simpleText ? it.length.simpleText : (it.lengthText || ''),
          views: it.viewCountText || it.viewCount || '',
          published: it.publishedTimeText || ''
        });
      }
    }

    res.json({
      query: raw,
      keywords,
      count: merged.length,
      items: merged
    });
  } catch (err) {
    console.error('auto-playlist error:', err);
    res.status(500).json({ error: '生成に失敗しました', items: [] });
  }
});

app.get('/playlist', async (req, res) => {
  const listId = req.query.list || '';
  if (!listId) return res.status(400).send('list parameter required');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>プレイリスト - MIN-Tube-Lite</title>
<script>(function(){try{if(localStorage.getItem('theme')==='light'){document.documentElement.classList.add('light-mode');}}catch(e){}})();</script>
<style>
  :root{ --bg:#0f0f0f; --text:#f1f1f1; --muted:#a0a0a0; --brand:#5aa9ff; --card:#1a1a1a; --hover:rgba(255,255,255,0.05); --radius:14px; }
  html.light-mode{ --bg:#f7f8fa; --text:#14161a; --muted:#5e6470; --brand:#2f7df0; --card:#eef0f3; --hover:rgba(0,0,0,0.04); }
  body { background:var(--bg); color:var(--text); font-family: Roboto, sans-serif; margin:0; padding:28px; transition:background .3s,color .3s; }
  .pl-header { display:flex; align-items:center; gap:12px; margin-bottom:18px; }
  .pl-header a { color:var(--brand); text-decoration:none; font-weight:500; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-0.3px; }
  .meta { color:var(--muted); font-size:13px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:16px 16px; row-gap:24px; }
  .vc { color:inherit; text-decoration:none; border-radius:var(--radius); padding:6px; transition:background .18s ease; }
  .vc:hover { background:var(--hover); }
  .vc .t { width:100%; aspect-ratio:16/9; background:var(--card); border-radius:12px; overflow:hidden; position:relative; margin-bottom:8px; }
  .vc .t img { width:100%; height:100%; object-fit:cover; }
  .vc .ttl { font-size:14px; font-weight:500; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .vc .ch { font-size:12px; color:var(--muted); margin-top:2px; }
  .vc .dur { position:absolute; bottom:6px; right:6px; background:rgba(0,0,0,0.85); color:#fff; padding:2px 5px; border-radius:6px; font-size:12px; font-weight:700; }
  .loader { text-align:center; padding:40px; color:var(--muted); }
</style></head><body>
<div class="pl-header"><a href="/">← 戻る</a></div>
<h1 id="plTitle">プレイリスト読み込み中...</h1>
<div class="meta" id="plMeta"></div>
<div id="grid" class="grid" style="margin-top:18px;"></div>
<div id="loader" class="loader">読み込み中…</div>
<script>
(async () => {
  try {
    const r = await fetch('/api/playlist/' + encodeURIComponent(${JSON.stringify(listId)}));
    const data = await r.json();
    const items = data.items || [];
    const meta = data.metadata || {};
    document.getElementById('plTitle').textContent = meta.title || 'プレイリスト';
    document.getElementById('plMeta').textContent = (meta.author ? meta.author + ' • ' : '') + items.length + '本の動画';
    document.getElementById('loader').style.display = 'none';
    const grid = document.getElementById('grid');
    items.forEach(it => {
      if (!it || !it.id) return;
      const id = typeof it.id === 'string' ? it.id : (it.id.videoId || it.id);
      let thumb = '';
      if (Array.isArray(it.thumbnail)) thumb = it.thumbnail[it.thumbnail.length-1]?.url || '';
      else if (it.thumbnail && it.thumbnail.thumbnails) thumb = it.thumbnail.thumbnails[it.thumbnail.thumbnails.length-1]?.url || '';
      if (!thumb) thumb = 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';
      const a = document.createElement('a');
      a.className = 'vc';
      a.href = '/video/' + id;
      a.innerHTML = '<div class="t"><img src="' + thumb + '" loading="lazy">' + (it.lengthText ? '<div class="dur">' + it.lengthText + '</div>' : '') + '</div><div class="ttl">' + (it.title||'') + '</div><div class="ch">' + (it.channelTitle||it.shortBylineText||'') + '</div>';
      grid.appendChild(a);
    });
    if (items.length === 0) grid.innerHTML = '<p style="color:#aaa;">このプレイリストには動画がありません。</p>';
  } catch (e) {
    document.getElementById('loader').textContent = 'プレイリストの読み込みに失敗しました';
  }
})();
</script></body></html>`);
});

// ── プレイリスト連続再生ページ (ローカルプレイリスト mt_playlists 用) ──
// /playlist-play?pl=<plId>&i=<index>&m=<再生方法>
//   m 例: googlevideo(既定) / youtube-nocookie / DL-Pro /
//         YoutubeEdu-Kahoot / YoutubeEdu-Scratch / Youtube-Pro / auto
app.get('/playlist-play', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>プレイリスト再生 - MIN-Tube-Lite</title>
<link rel="icon" href="/min-img.png">
<script>(function(){try{if(localStorage.getItem('theme')==='light'){document.documentElement.classList.add('light-mode');}}catch(e){}})();</script>
<style>
  :root{ --bg:#0f0f0f; --panel:#181818; --panel2:#232323; --panel3:#2d2d2d; --text:#f1f1f1; --muted:#a0a0a0; --brand:#5aa9ff; --brand-soft:rgba(90,169,255,.14); --brand-text:#0f0f0f; --border:rgba(255,255,255,.08); --track:#444; }
  html.light-mode{ --bg:#f7f8fa; --panel:#ffffff; --panel2:#eef0f3; --panel3:#e2e6eb; --text:#14161a; --muted:#5e6470; --brand:#2f7df0; --brand-soft:rgba(47,125,240,.10); --brand-text:#ffffff; --border:rgba(0,0,0,.07); --track:#d4d8de; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--bg); color:var(--text); font-family:Roboto,'Noto Sans JP',system-ui,sans-serif; transition:background .3s,color .3s; }
  .topbar{ display:flex; align-items:center; gap:12px; padding:12px 18px; background:var(--panel); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:20; }
  .topbar a.back{ color:var(--text); text-decoration:none; display:inline-flex; align-items:center; gap:6px; font-size:14px; padding:8px 12px; border-radius:8px; background:var(--panel2); }
  .topbar a.back:hover{ background:var(--panel3); }
  .topbar .brand{ font-weight:700; font-size:16px; }
  .topbar .brand b{ color:var(--brand); }
  .layout{ display:flex; gap:20px; padding:20px; max-width:1500px; margin:0 auto; align-items:flex-start; }
  .main{ flex:1; min-width:0; }
  .player-wrap{ position:relative; width:100%; aspect-ratio:16/9; background:#000; border-radius:14px; overflow:hidden; }
  .player-wrap iframe{ width:100%; height:100%; border:0; display:block; }
  .now-title{ font-size:19px; font-weight:600; margin:16px 0 6px; line-height:1.4; }
  .now-meta{ color:var(--muted); font-size:13px; margin-bottom:14px; }
  .controls{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:6px; }
  .ctl{ display:inline-flex; align-items:center; gap:7px; background:var(--panel2); color:var(--text); border:1px solid transparent; padding:8px 14px; border-radius:20px; cursor:pointer; font-size:13px; user-select:none; transition:background .15s,transform .1s; }
  .ctl:hover{ background:var(--panel3); }
  .ctl:active{ transform:scale(.96); }
  .ctl.on{ background:var(--brand); color:var(--brand-text); font-weight:600; }
  .sw{ width:30px; height:16px; background:#888; border-radius:16px; position:relative; transition:background .2s; }
  .ctl.on .sw{ background:var(--brand-text); }
  .sw::after{ content:''; position:absolute; top:2px; left:2px; width:12px; height:12px; border-radius:50%; background:#fff; transition:left .2s; }
  .ctl.on .sw::after{ left:16px; }
  .method-dropdown{ position:relative; display:inline-block; }
  .method-dropdown .ctl{ border:0; }
  .method-cur{ background:var(--brand-soft); color:var(--brand); padding:2px 8px; border-radius:10px; font-size:12px; font-weight:600; }
  .method-menu{ position:absolute; top:calc(100% + 6px); left:0; min-width:230px; background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:6px; box-shadow:0 12px 32px rgba(0,0,0,.35); z-index:50; display:none; }
  .method-menu.show{ display:block; }
  .method-opt{ display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 12px; border-radius:8px; cursor:pointer; font-size:13px; color:var(--text); }
  .method-opt:hover{ background:var(--panel2); }
  .method-opt.active{ background:var(--brand-soft); color:var(--brand); font-weight:600; }
  .method-tag{ font-size:10px; background:var(--brand); color:var(--brand-text); padding:1px 7px; border-radius:8px; font-weight:700; }
  .sidebar{ width:400px; min-width:340px; background:var(--panel); border:1px solid var(--border); border-radius:14px; overflow:hidden; max-height:calc(100vh - 60px); display:flex; flex-direction:column; position:sticky; top:80px; }
  .sb-head{ padding:14px 16px; border-bottom:1px solid var(--border); }
  .sb-head .pl-name{ font-size:16px; font-weight:700; }
  .sb-head .pl-prog{ font-size:12px; color:var(--muted); margin-top:3px; }
  .sb-list{ overflow-y:auto; flex:1; }
  .pl-item{ display:flex; gap:10px; padding:9px 12px; cursor:pointer; align-items:center; border-left:3px solid transparent; }
  .pl-item:hover{ background:var(--brand-soft); }
  .pl-item.active{ background:var(--brand-soft); border-left-color:var(--brand); }
  .pl-item .idx{ width:20px; text-align:center; font-size:12px; color:var(--muted); flex-shrink:0; }
  .pl-item.active .idx{ color:var(--brand); font-weight:700; }
  .pl-item .pi-thumb{ width:96px; min-width:96px; aspect-ratio:16/9; border-radius:6px; overflow:hidden; background:#000; position:relative; }
  .pl-item .pi-thumb img{ width:100%; height:100%; object-fit:cover; }
  .pl-item .pi-thumb .now-badge{ position:absolute; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; color:#fff; font-size:11px; font-weight:700; }
  .pl-item .pi-info{ flex:1; min-width:0; }
  .pl-item .pi-title{ font-size:13px; font-weight:500; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .pl-item .pi-ch{ font-size:11px; color:var(--muted); margin-top:3px; }
  .empty{ padding:50px 20px; text-align:center; color:var(--muted); }
  .empty a{ color:var(--brand); }
  .next-toast{ position:fixed; right:24px; bottom:24px; background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:14px 16px; width:300px; box-shadow:0 12px 32px rgba(0,0,0,.35); transform:translateY(140%); transition:transform .35s cubic-bezier(.2,.8,.2,1); z-index:40; }
  .next-toast.show{ transform:translateY(0); }
  .next-toast .nt-label{ font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
  .next-toast .nt-title{ font-size:14px; font-weight:600; margin:4px 0 10px; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .next-toast .nt-bar{ height:3px; background:var(--track); border-radius:3px; overflow:hidden; margin-bottom:10px; }
  .next-toast .nt-bar > div{ height:100%; background:var(--brand); width:100%; }
  .next-toast .nt-act{ display:flex; gap:8px; }
  .next-toast button{ flex:1; border:0; border-radius:8px; padding:8px; font-size:13px; cursor:pointer; }
  .next-toast .nt-cancel{ background:var(--panel3); color:var(--text); }
  .next-toast .nt-play{ background:var(--brand); color:var(--brand-text); font-weight:600; }
  @media (max-width:980px){
    .layout{ flex-direction:column; padding:12px; }
    .sidebar{ width:100%; min-width:0; position:static; max-height:none; }
    .sb-list{ max-height:420px; }
  }
</style></head><body>
<div class="topbar">
  <a class="back" href="/">←&nbsp;ホーム</a>
  <span class="brand">MIN-Tube<b>-Lite</b></span>
</div>
<div class="layout">
  <div class="main">
    <div class="player-wrap" id="playerWrap">
      <iframe id="plFrame" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
    </div>
    <div class="now-title" id="nowTitle">読み込み中…</div>
    <div class="now-meta" id="nowMeta"></div>
    <div class="controls">
      <div class="ctl" id="autoplayCtl" title="動画終了時に自動で次へ"><span>自動再生</span><span class="sw"></span></div>
      <div class="ctl" id="loopCtl" title="最後まで再生したら最初へ戻る"><span>ループ</span><span class="sw"></span></div>
      <div class="ctl" id="shuffleCtl" title="シャッフル再生"><span>シャッフル</span><span class="sw"></span></div>
      <div class="method-dropdown" id="methodDropdown">
        <button class="ctl" id="methodBtn" title="再生方法を選ぶ"><span>⚙ 再生方法</span><span id="methodCur" class="method-cur">Googlevideo</span><span style="font-size:10px;">▾</span></button>
        <div class="method-menu" id="methodMenu">
          <div class="method-opt" data-method="googlevideo">Googlevideo<span class="method-tag">標準</span></div>
          <div class="method-opt" data-method="youtube-nocookie">Youtube-nocookie</div>
          <div class="method-opt" data-method="DL-Pro">DL-Pro</div>
          <div class="method-opt" data-method="YoutubeEdu-Kahoot">YoutubeEdu-Kahoot</div>
          <div class="method-opt" data-method="YoutubeEdu-Scratch">YoutubeEdu-Scratch</div>
          <div class="method-opt" data-method="Youtube-Pro">Youtube-Pro</div>
          <div class="method-opt" data-method="auto">自動 (フォールバック)</div>
        </div>
      </div>
      <button class="ctl" id="prevBtn">⏮ 前へ</button>
      <button class="ctl" id="nextBtn">次へ ⏭</button>
    </div>
  </div>
  <div class="sidebar">
    <div class="sb-head">
      <div class="pl-name" id="plName">プレイリスト</div>
      <div class="pl-prog" id="plProg"></div>
    </div>
    <div class="sb-list" id="plList"></div>
  </div>
</div>
<div class="next-toast" id="nextToast">
  <div class="nt-label">次の動画</div>
  <div class="nt-title" id="ntTitle"></div>
  <div class="nt-bar"><div id="ntBar"></div></div>
  <div class="nt-act">
    <button class="nt-cancel" id="ntCancel">キャンセル</button>
    <button class="nt-play" id="ntPlay">今すぐ再生</button>
  </div>
</div>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
(function(){
  const params = new URLSearchParams(location.search);
  const plId = params.get('pl') || '';
  let curIndex = parseInt(params.get('i')) || 0;
  const LIB_PLAYLISTS = 'mt_playlists';

  function getPlaylists(){ try{ return JSON.parse(localStorage.getItem(LIB_PLAYLISTS)||'[]'); }catch(e){ return []; } }
  const pls = getPlaylists();
  const pl = pls.find(p => p.id === plId);
  let items = (pl && Array.isArray(pl.items)) ? pl.items.slice() : [];
  // 再生順 (シャッフル時は order を入れ替え)
  let order = items.map((_, i) => i);

  // 設定 (localStorage)
  let autoplay = localStorage.getItem('plp_autoplay') !== '0';
  let loop      = localStorage.getItem('plp_loop') === '1';
  let shuffle   = localStorage.getItem('plp_shuffle') === '1';

  // 再生方法。通常は googlevideo。
  //   ・プレイリスト専用の設定 plp_method を優先
  //   ・無ければ動画視聴ページと共有の playbackMode を流用
  //   ・どちらも無ければ googlevideo
  const METHODS = {
    'googlevideo':        { label:'Googlevideo' },
    'youtube-nocookie':   { label:'Youtube-nocookie' },
    'DL-Pro':             { label:'DL-Pro' },
    'YoutubeEdu-Kahoot':  { label:'YoutubeEdu-Kahoot' },
    'YoutubeEdu-Scratch': { label:'YoutubeEdu-Scratch' },
    'Youtube-Pro':        { label:'Youtube-Pro' },
    'auto':               { label:'自動 (フォールバック)' }
  };
  let playMethod = params.get('m')                  // URL ?m=... が最優先
                || localStorage.getItem('plp_method')
                || localStorage.getItem('playbackMode')
                || 'googlevideo';
  if(!METHODS[playMethod]) playMethod = 'googlevideo';
  // 旧 EDU トグル設定からの移行 (一度だけ)
  if(!params.get('m') && !localStorage.getItem('plp_method') && localStorage.getItem('plp_edu') === '1'){
    playMethod = 'YoutubeEdu-Scratch';
  }
  // EDU 系メソッドかどうか
  function isEduMethod(m){ return m === 'YoutubeEdu-Kahoot' || m === 'YoutubeEdu-Scratch'; }
  let eduMode = isEduMethod(playMethod);

  const $ = id => document.getElementById(id);

  if(!pl || !items.length){
    document.querySelector('.layout').innerHTML =
      '<div class="empty">再生リストが見つからないか空です。<br><br><a href="/">ホームに戻る</a></div>';
    return;
  }

  $('plName').textContent = pl.name || 'プレイリスト';

  function thumb(id){ return 'https://i.ytimg.com/vi/'+id+'/mqdefault.jpg'; }
  function curVid(){ return items[order[curIndex]]; }

  function applyShuffle(){
    const playingVid = curVid();
    order = items.map((_,i)=>i);
    if(shuffle){
      for(let k=order.length-1;k>0;k--){ const j=Math.floor(Math.random()*(k+1)); [order[k],order[j]]=[order[j],order[k]]; }
    }
    // 現在再生中の動画を先頭インデックスに合わせ直す
    if(playingVid){ const np = order.findIndex(o => items[o].id === playingVid.id); if(np>=0) curIndex = np; }
  }

  function renderList(){
    const list = $('plList');
    list.innerHTML = order.map((o,pos)=>{
      const it = items[o];
      const active = pos === curIndex;
      return '<div class="pl-item'+(active?' active':'')+'" data-pos="'+pos+'">'
        + '<div class="idx">'+(active?'▶':(pos+1))+'</div>'
        + '<div class="pi-thumb"><img src="'+thumb(it.id)+'" loading="lazy">'+(active?'<div class="now-badge">再生中</div>':'')+'</div>'
        + '<div class="pi-info"><div class="pi-title">'+(it.title||'')+'</div><div class="pi-ch">'+(it.channel||'')+'</div></div>'
        + '</div>';
    }).join('');
    list.querySelectorAll('.pl-item').forEach(el=>{
      el.addEventListener('click', ()=>{ curIndex = parseInt(el.dataset.pos); playCurrent(); });
    });
    $('plProg').textContent = (curIndex+1)+' / '+items.length+'本';
    const active = list.querySelector('.pl-item.active');
    if(active) active.scrollIntoView({block:'nearest'});
  }

  // ===== プレーヤー =====
  let ytPlayer = null;
  let usingEdu = false;
  let endGuard = null;
  // フォールバック制御: 同じ動画でソースを順番に試す
  let curPlayToken = 0;       // playCurrent ごとに発行 (古い試行を無効化)
  let fbIndex = 0;            // 現在試しているフォールバックソースの番号
  let fbTimer = null;         // 再生開始確認用タイマー
  let playStarted = false;    // 実際に再生が始まったか

  // EDU 用 URL を取得 (失敗時は素の youtubeeducation URL)
  function buildEduUrl(id){
    return fetch('/scratch-edu/'+id)
      .then(r => r.ok ? r.text() : '')
      .then(t => (t && /^https?:/.test(t.trim())) ? t.trim() : '')
      .catch(()=>'');
  }
  function buildKahootUrl(id){
    return fetch('/kahoot-edu/'+id)
      .then(r => r.ok ? r.text() : '')
      .then(t => (t && /^https?:/.test(t.trim())) ? t.trim() : '')
      .catch(()=>'');
  }

  // iframe ベースで指定 URL を読み込む (エラー検知付き)
  function loadIframe(url, token){
    destroyYt();
    const wrap = $('playerWrap');
    wrap.innerHTML = '<iframe id="plFrame" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>';
    const fr = $('plFrame');
    fr.onload = ()=>{ if(token===curPlayToken){ playStarted = true; } };
    fr.onerror = ()=>{ if(token===curPlayToken){ tryNextSource(token); } };
    fr.src = url;
  }

  // 選択された再生方法を先頭に置き、失敗時のフォールバックを後ろに並べる。
  //  type 一覧:
  //   googlevideo … /360/ の直リンクを <video> で再生 (ended で自動次へ)
  //   yt          … YouTube IFrame API (ended 検知できる)
  //   nocookie    … youtube-nocookie iframe
  //   pro         … /pro-stream iframe
  //   edu         … /scratch-edu iframe
  //   kahoot      … /kahoot-edu iframe
  function buildSourceChain(id){
    const ytApiOk = !!(window.YT && window.YT.Player);
    // 各メソッドの「本命 type」
    const primary = {
      'googlevideo':        'googlevideo',
      'youtube-nocookie':   'nocookie',
      'DL-Pro':             'googlevideo', // DL-Pro も /360/ 直リンク
      'YoutubeEdu-Kahoot':  'kahoot',
      'YoutubeEdu-Scratch': 'edu',
      'Youtube-Pro':        'pro',
      'auto':               null
    };
    // フォールバック全体の標準順 (本命の後に続ける)
    const fallbackOrder = ['googlevideo', 'yt', 'nocookie', 'pro', 'edu', 'kahoot'];

    const want = primary[playMethod];
    const chain = [];
    const seen = new Set();
    const push = (t)=>{
      if(!t || seen.has(t)) return;
      if(t === 'yt' && !ytApiOk) return; // YT API 未ロードならスキップ
      seen.add(t); chain.push({ type:t });
    };

    if(playMethod === 'auto'){
      // 自動: YT(ended検知) を最優先に従来のフォールバック
      push('yt'); push('googlevideo'); push('nocookie'); push('pro'); push('edu'); push('kahoot');
    } else {
      push(want);                       // ユーザーが選んだ方法を最優先
      fallbackOrder.forEach(t => push(t)); // 残りをフォールバックとして追加
    }
    return chain;
  }

  async function tryNextSource(token){
    if(token !== curPlayToken) return; // 古い試行は破棄
    const it = curVid();
    if(!it) return;
    const chain = buildSourceChain(it.id);
    if(fbIndex >= chain.length){
      // すべて失敗
      showPlayError(it.id);
      return;
    }
    const src = chain[fbIndex];
    fbIndex++;
    playStarted = false;
    armPlayWatchdog(token); // 一定時間 onload/再生が無ければ次へ

    if(src.type === 'googlevideo'){
      usingEdu = false;
      await loadGooglevideo(it.id, token);
    } else if(src.type === 'yt'){
      usingEdu = false;
      loadYt(it.id, token);
    } else if(src.type === 'pro'){
      usingEdu = false;
      loadIframe('/pro-stream/'+it.id, token);
    } else if(src.type === 'nocookie'){
      usingEdu = false;
      loadIframe('https://www.youtube-nocookie.com/embed/'+it.id+'?autoplay=1&rel=0&modestbranding=1', token);
    } else if(src.type === 'edu'){
      usingEdu = true;
      let url = await buildEduUrl(it.id);
      if(token !== curPlayToken) return;
      if(!url) url = 'https://www.youtubeeducation.com/embed/'+it.id;
      url += (url.includes('?')?'&':'?')+'autoplay=1';
      loadIframe(url, token);
    } else if(src.type === 'kahoot'){
      usingEdu = true;
      let url = await buildKahootUrl(it.id);
      if(token !== curPlayToken) return;
      if(!url) url = 'https://www.youtubeeducation.com/embed/'+it.id;
      url += (url.includes('?')?'&':'?')+'autoplay=1';
      loadIframe(url, token);
    }
  }

  // 再生開始を一定時間監視し、始まらなければ次のソースへ
  function armPlayWatchdog(token){
    if(fbTimer){ clearTimeout(fbTimer); fbTimer=null; }
    fbTimer = setTimeout(()=>{
      if(token !== curPlayToken) return;
      // YT プレーヤーが PLAYING/PAUSED/BUFFERING いずれかなら成功とみなす
      let okState = false;
      if(ytPlayer && ytPlayer.getPlayerState){
        try{
          const st = ytPlayer.getPlayerState();
          okState = (st === 1 || st === 2 || st === 3 || st === 5);
        }catch(e){}
      }
      if(!playStarted && !okState){
        tryNextSource(token);
      }
    }, 4500);
  }

  function showPlayError(id){
    const wrap = $('playerWrap');
    wrap.innerHTML =
      '<div style="position:absolute;inset:0;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;gap:14px;text-align:center;padding:20px;color:#ddd;">'
      + '<div style="font-size:40px;">⚠️</div>'
      + '<div style="font-size:16px;font-weight:600;">この動画は再生できませんでした</div>'
      + '<div style="font-size:13px;color:#aaa;">埋め込みが制限されている可能性があります。</div>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">'
      + '<button id="errRetry" style="background:#3ea6ff;color:#0f0f0f;border:0;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;">別の方法で再試行</button>'
      + '<a href="https://www.youtube.com/watch?v='+id+'" target="_blank" rel="noopener" style="background:#333;color:#fff;border-radius:8px;padding:9px 16px;font-size:13px;text-decoration:none;">YouTubeで開く</a>'
      + '<button id="errSkip" style="background:#333;color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:13px;cursor:pointer;">次の動画へ</button>'
      + '</div></div>';
    const r = document.getElementById('errRetry');
    if(r) r.onclick = ()=>{ fbIndex = 0; playCurrent(); };
    const s = document.getElementById('errSkip');
    if(s) s.onclick = ()=>{ goNext(); };
  }

  async function playCurrent(){
    const it = curVid();
    if(!it){ return; }
    $('nowTitle').textContent = it.title || '';
    $('nowMeta').textContent = (it.channel||'') + (it.views? ' • '+it.views : '');
    history.replaceState(null,'','/playlist-play?pl='+encodeURIComponent(plId)+'&i='+curIndex+(playMethod!=='googlevideo'?'&m='+encodeURIComponent(playMethod):''));
    renderList();
    hideNextToast();

    // 新しい再生試行: トークンを更新しフォールバックを先頭から
    curPlayToken++;
    fbIndex = 0;
    playStarted = false;
    if(fbTimer){ clearTimeout(fbTimer); fbTimer=null; }
    armEduGuard(it.id);
    tryNextSource(curPlayToken);
  }

  function destroyYt(){ if(ytPlayer){ try{ ytPlayer.destroy(); }catch(e){} ytPlayer=null; } if(endGuard){ clearInterval(endGuard); endGuard=null; } }

  // googlevideo: /360/ から取得した直リンクを <video> で再生する。
  //  ・ended で自動的に次の動画へ (onEnded)
  //  ・取得失敗 / 再生エラー時はフォールバックチェーンへ
  async function loadGooglevideo(id, token){
    destroyYt();
    let url = '';
    try{
      const r = await fetch('/360/'+id);
      if(r.ok) url = (await r.text()).trim();
    }catch(e){}
    if(token !== curPlayToken) return;
    if(!url || !/^https?:/.test(url)){ tryNextSource(token); return; }

    const wrap = $('playerWrap');
    wrap.innerHTML = '<video id="plVideo" controls autoplay playsinline '
      + 'style="width:100%;height:100%;background:#000;"></video>';
    const v = $('plVideo');
    v.src = url;
    v.onplaying = ()=>{ if(token===curPlayToken) playStarted = true; };
    v.onended   = ()=>{ if(token===curPlayToken) onEnded(); };
    v.onerror   = ()=>{ if(token===curPlayToken) tryNextSource(token); };
    const p = v.play();
    if(p && p.catch) p.catch(()=>{ /* 自動再生ブロック時はユーザー操作待ち */ });
  }

  function loadYt(id, token){
    destroyYt();
    // iframe を YT 管理用 div に差し替え
    const wrap = $('playerWrap');
    wrap.innerHTML = '<div id="ytmount"></div>';
    ytPlayer = new YT.Player('ytmount', {
      videoId: id,
      playerVars: { autoplay:1, rel:0, modestbranding:1 },
      events: {
        onReady: (e)=>{ try{ e.target.playVideo(); }catch(err){} },
        onStateChange: (e)=>{
          // 再生・バッファリング開始で成功とみなす
          if(e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.BUFFERING){
            if(token===curPlayToken) playStarted = true;
          }
          if(e.data === YT.PlayerState.ENDED){ if(token===curPlayToken) onEnded(); }
        },
        // エラー (101/150=埋め込み不可, 100=削除, 2/5=パラメータ等) → 次のソースへ
        onError: (e)=>{ if(token===curPlayToken){ tryNextSource(token); } }
      }
    });
  }

  // EDU(iframe)用フォールバック: 推測タイマーは使わず、ユーザー操作で次へ進む設計
  function armEduGuard(id){ if(endGuard){ clearInterval(endGuard); endGuard=null; } }

  function onEnded(){
    if(loop && curIndex >= items.length-1){ curIndex = 0; showNextToast(); return; }
    if(curIndex < items.length-1){ showNextToast(); }
  }

  // ===== 次の動画トースト =====
  let toastTimer=null;
  function showNextToast(){
    if(!autoplay){ goNext(); return; }
    const nextPos = nextIndex();
    if(nextPos===null) return;
    const it = items[order[nextPos]];
    $('ntTitle').textContent = it.title||'';
    $('nextToast').classList.add('show');
    const dur=6000, start=Date.now();
    clearInterval(toastTimer);
    toastTimer=setInterval(()=>{
      const remain=Math.max(0,dur-(Date.now()-start));
      $('ntBar').style.width=(remain/dur*100)+'%';
      if(remain<=0){ clearInterval(toastTimer); toastTimer=null; goNext(); }
    },80);
  }
  function hideNextToast(){ clearInterval(toastTimer); toastTimer=null; $('nextToast').classList.remove('show'); }

  function nextIndex(){
    if(curIndex < items.length-1) return curIndex+1;
    if(loop) return 0;
    return null;
  }
  function goNext(){ const n=nextIndex(); if(n===null){ hideNextToast(); return; } curIndex=n; playCurrent(); }
  function goPrev(){ if(curIndex>0){ curIndex--; } else if(loop){ curIndex=items.length-1; } playCurrent(); }

  // ===== コントロール UI =====
  function syncCtl(){
    $('autoplayCtl').classList.toggle('on', autoplay);
    $('loopCtl').classList.toggle('on', loop);
    $('shuffleCtl').classList.toggle('on', shuffle);
    // 再生方法 表示の同期
    const cur = (METHODS[playMethod] || METHODS['googlevideo']).label;
    if($('methodCur')) $('methodCur').textContent = cur;
    document.querySelectorAll('.method-opt').forEach(opt=>{
      opt.classList.toggle('active', opt.dataset.method === playMethod);
    });
  }
  $('autoplayCtl').onclick=()=>{ autoplay=!autoplay; localStorage.setItem('plp_autoplay',autoplay?'1':'0'); if(!autoplay) hideNextToast(); syncCtl(); };
  $('loopCtl').onclick=()=>{ loop=!loop; localStorage.setItem('plp_loop',loop?'1':'0'); syncCtl(); };
  $('shuffleCtl').onclick=()=>{ shuffle=!shuffle; localStorage.setItem('plp_shuffle',shuffle?'1':'0'); applyShuffle(); syncCtl(); renderList(); };

  // 再生方法ドロップダウン
  function setPlayMethod(m){
    if(!METHODS[m] || m === playMethod){ $('methodMenu').classList.remove('show'); return; }
    playMethod = m;
    eduMode = isEduMethod(m);
    localStorage.setItem('plp_method', m);
    // 動画視聴ページと共有 (auto は共有しない)
    if(m !== 'auto') localStorage.setItem('playbackMode', m);
    $('methodMenu').classList.remove('show');
    syncCtl();
    playCurrent(); // 選んだ方法で今の動画を再生し直す
  }
  $('methodBtn').onclick=(e)=>{ e.stopPropagation(); $('methodMenu').classList.toggle('show'); };
  document.querySelectorAll('.method-opt').forEach(opt=>{
    opt.addEventListener('click', ()=> setPlayMethod(opt.dataset.method));
  });
  document.addEventListener('click', (e)=>{
    if(!e.target.closest('#methodDropdown')){ $('methodMenu').classList.remove('show'); }
  });

  $('prevBtn').onclick=goPrev;
  $('nextBtn').onclick=()=>{ hideNextToast(); goNext(); };
  $('ntCancel').onclick=hideNextToast;
  $('ntPlay').onclick=()=>{ hideNextToast(); goNext(); };

  // YouTube IFrame API 準備完了
  let ytApiReady = !!(window.YT && window.YT.Player);
  let startedOnce = false;
  window.onYouTubeIframeAPIReady = function(){
    ytApiReady = true;
    // まだ一度も再生開始していなければここで開始 (YT 本命ソースを使える)
    if(!startedOnce){ startedOnce = true; playCurrent(); }
  };

  // 初期化
  if(curIndex<0||curIndex>=items.length) curIndex=0;
  applyShuffle();
  syncCtl();
  renderList();

  // メタ情報を先に表示
  (function(){ const it=curVid(); if(it){ $('nowTitle').textContent=it.title||''; $('nowMeta').textContent=(it.channel||''); } })();

  // 「自動」以外の方法は YT API を待つ必要がないので即再生。
  //  「自動」かつ API 未ロードのときだけ、API 到着 or タイムアウトで起動する。
  if(playMethod !== 'auto' || ytApiReady){
    startedOnce = true; playCurrent();
  } else {
    // API ロードが遅い場合に備え、一定時間で待たずに再生開始 (フォールバックで対応)
    setTimeout(()=>{ if(!startedOnce){ startedOnce = true; playCurrent(); } }, 2500);
  }
})();
</script></body></html>`);
});

// ── 更新履歴 (CHANGELOG.md の「## 更新履歴」セクションをパース) ──
//  v1.4.0: 開発者向けの詳細な履歴は README.md から CHANGELOG.md に移動。
//  互換のため、CHANGELOG.md が無い場合は README.md にフォールバックする。
let _changelogCache = null;
let _changelogCacheAt = 0;
function parseChangelog() {
  const now = Date.now();
  if (_changelogCache && (now - _changelogCacheAt) < 5 * 60 * 1000) return _changelogCache;
  let md = '';
  try {
    md = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
  } catch (e) {
    try { md = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8'); } catch (e2) { md = ''; }
  }

  // 「## 更新履歴」から次の「## 」見出しまでを切り出す
  const startIdx = md.indexOf('## 更新履歴');
  let section = '';
  if (startIdx >= 0) {
    const rest = md.slice(startIdx + '## 更新履歴'.length);
    const nextH2 = rest.search(/\n##\s/);
    section = nextH2 >= 0 ? rest.slice(0, nextH2) : rest;
  }

  // 各バージョン (### で始まる行) ごとに分割
  const lines = section.split(/\r?\n/);
  const versions = [];
  let cur = null;
  const inlineMd = (s) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>');

  for (const line of lines) {
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      if (cur) versions.push(cur);
      const titleRaw = h3[1].trim();
      cur = { version: titleRaw, blocks: [] };
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    if (!t) continue;
    if (/^\*\*(.+?)\*\*$/.test(t)) {
      // セクションヘッダ (例: **✨ 新機能**)
      cur.blocks.push({ type: 'head', text: inlineMd(t.replace(/^\*\*|\*\*$/g, '')) });
    } else {
      const li = t.match(/^(\s*)[-*]\s+(.*)$/);
      if (li) {
        const indent = (line.match(/^(\s*)[-*]/) || [,''])[1].length;
        cur.blocks.push({ type: 'li', level: indent >= 2 ? 1 : 0, text: inlineMd(li[2]) });
      } else {
        cur.blocks.push({ type: 'p', text: inlineMd(t) });
      }
    }
  }
  if (cur) versions.push(cur);

  _changelogCache = versions;
  _changelogCacheAt = now;
  return versions;
}

app.get('/api/changelog', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({ versions: parseChangelog() });
});

app.get('/changelog', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>更新履歴 - MIN-Tube-Lite</title>
<link rel="icon" href="/min-img.png">
<script>(function(){try{if(localStorage.getItem('theme')==='light'){document.documentElement.classList.add('light-mode');}}catch(e){}})();</script>
<style>
  :root{ --bg:#0f0f0f; --panel:#181818; --panel2:#232323; --panel3:#2d2d2d; --text:#f1f1f1; --muted:#a0a0a0; --brand:#5aa9ff; --brand-soft:rgba(90,169,255,.15); --border:rgba(255,255,255,.08); --strong:#f1f1f1; --body:#dddddd; --code-bg:#2a2a2a; --code-fg:#ffd479; }
  html.light-mode{ --bg:#f7f8fa; --panel:#ffffff; --panel2:#eef0f3; --panel3:#e2e6eb; --text:#14161a; --muted:#5e6470; --brand:#2f7df0; --brand-soft:rgba(47,125,240,.12); --border:rgba(0,0,0,.07); --strong:#14161a; --body:#33373f; --code-bg:#eef0f3; --code-fg:#b06a00; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--bg); color:var(--text); font-family:Roboto,'Noto Sans JP',system-ui,sans-serif; line-height:1.6; transition:background .3s,color .3s; }
  .topbar{ display:flex; align-items:center; gap:12px; padding:12px 18px; background:var(--panel); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:20; }
  .topbar a.back{ color:var(--text); text-decoration:none; display:inline-flex; align-items:center; gap:6px; font-size:14px; padding:8px 12px; border-radius:var(--radius,10px); background:var(--panel2); }
  .topbar a.back:hover{ background:var(--panel3); }
  .topbar .brand{ font-weight:700; font-size:16px; }
  .topbar .brand b{ color:var(--brand); }
  .container{ max-width:820px; margin:0 auto; padding:28px 20px 60px; }
  h1{ font-size:26px; margin:0 0 6px; }
  .sub{ color:var(--muted); font-size:14px; margin-bottom:28px; }
  .ver{ position:relative; padding:0 0 6px 22px; margin-bottom:30px; border-left:2px solid var(--border); }
  .ver::before{ content:''; position:absolute; left:-7px; top:4px; width:12px; height:12px; border-radius:50%; background:var(--brand); box-shadow:0 0 0 4px var(--brand-soft); }
  .ver:first-of-type::before{ background:#4caf50; box-shadow:0 0 0 4px rgba(76,175,80,.18); }
  .ver-title{ font-size:20px; font-weight:700; margin:0 0 4px; }
  .ver:first-of-type .ver-title::after{ content:'NEW'; font-size:10px; background:#4caf50; color:#08230b; font-weight:800; padding:2px 7px; border-radius:10px; margin-left:9px; vertical-align:middle; letter-spacing:.5px; }
  .blk-head{ font-size:14px; font-weight:700; margin:14px 0 6px; color:var(--strong); }
  ul.cl{ margin:6px 0; padding-left:20px; }
  ul.cl li{ font-size:14px; margin:3px 0; color:var(--body); }
  ul.cl li.sub{ list-style:circle; margin-left:14px; color:var(--muted); font-size:13px; }
  p.cl{ font-size:14px; color:var(--body); margin:6px 0; }
  code{ background:var(--code-bg); padding:1px 6px; border-radius:5px; font-size:12px; color:var(--code-fg); }
  .empty{ color:var(--muted); text-align:center; padding:40px; }
</style></head><body>
<div class="topbar">
  <a class="back" href="/">←&nbsp;ホーム</a>
  <span class="brand">MIN-Tube<b>-Lite</b></span>
</div>
<div class="container">
  <h1>更新履歴</h1>
  <div class="sub">MIN-Tube-Lite のアップデート内容を確認できます。</div>
  <div id="clRoot"><div class="empty">読み込み中…</div></div>
</div>
<script>
(async ()=>{
  try{
    const r = await fetch('/api/changelog');
    const data = await r.json();
    const versions = data.versions || [];
    const root = document.getElementById('clRoot');
    if(!versions.length){ root.innerHTML='<div class="empty">更新履歴がありません</div>'; return; }
    root.innerHTML = versions.map(v=>{
      let html = '<div class="ver"><div class="ver-title">'+v.version+'</div>';
      let ulOpen = false;
      const closeUl = ()=>{ if(ulOpen){ html+='</ul>'; ulOpen=false; } };
      (v.blocks||[]).forEach(b=>{
        if(b.type==='head'){ closeUl(); html+='<div class="blk-head">'+b.text+'</div>'; }
        else if(b.type==='li'){ if(!ulOpen){ html+='<ul class="cl">'; ulOpen=true; } html+='<li'+(b.level?' class="sub"':'')+'>'+b.text+'</li>'; }
        else { closeUl(); html+='<p class="cl">'+b.text+'</p>'; }
      });
      closeUl();
      html+='</div>';
      return html;
    }).join('');
  }catch(e){
    document.getElementById('clRoot').innerHTML='<div class="empty">更新履歴の読み込みに失敗しました</div>';
  }
})();
</script></body></html>`);
});


app.get("/api/recommendations", async (req, res) => {
  const { title, channel, id } = req.query;

  // タイトル＋チャンネルでキャッシュキーを構成 (id は除外して類似動画でも共有可能に)
  const cacheKey = `reco:${(title||'').toLowerCase().slice(0,80)}::${(channel||'').toLowerCase().slice(0,40)}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    cacheStats.hit++;
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, max-age=120');
    // 視聴中の動画自身を除外して返却
    const filtered = (cached.items || []).filter(it => it && it.id !== id);
    return res.json({ items: filtered });
  }
  cacheStats.miss++;

  try {
    const cleanKwd = title
      .replace(/[【】「」()!！?？\[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 元タイトルから関連性の高い検索クエリを構成（先頭の主要語を活用）
    const refTokens = tokenizeForRelevance(title).filter(t => t.length >= 2);
    const topicWords = cleanKwd.split(' ').filter(w => w.length >= 2);
    const mainTopic = topicWords.length > 0 ? topicWords.slice(0, 3).join(' ') : cleanKwd;
    // 主要語が無い（日本語のみ等）場合はトークンから補う
    const fallbackTopic = refTokens.slice(0, 3).join(' ');
    const topicQuery = mainTopic || fallbackTopic || title;

    const [topicRes, channelRes, relatedRes] = await Promise.all([
      yts.GetListByKeyword(`${topicQuery}`, false, 16),
      channel ? yts.GetListByKeyword(`${channel}`, false, 10) : Promise.resolve({ items: [] }),
      yts.GetListByKeyword(`${topicQuery} 関連`, false, 10)
    ]);

    let rawList = [
      ...(topicRes.items || []),
      ...(channelRes.items || []),
      ...(relatedRes.items || [])
    ];

    // 動画のみ・重複(ID/類似タイトル)を除外
    const seenIds = new Set([id]);
    const seenNormalizedTitles = new Set();
    const dedupedItems = [];

    for (const item of rawList) {
      if (!item.id || item.type !== 'video') continue;
      if (seenIds.has(item.id)) continue;
      if (!item.title) continue;

      const normalized = item.title.toLowerCase()
        .replace(/\s+/g, '')
        .replace(/official|lyrics|mv|musicvideo|video|公式|実況|解説/g, '');

      const titleSig = normalized.substring(0, 12);
      if (titleSig && seenNormalizedTitles.has(titleSig)) continue;

      seenIds.add(item.id);
      if (titleSig) seenNormalizedTitles.add(titleSig);
      dedupedItems.push(item);
    }

    // ★ 関連性スコアで並べ替え＋無関係な動画を除外（少なくとも1語以上一致 or 同一チャンネル）
    // ショート動画は関連パネルではノイズになりやすいので基本除外（不足時のみ補完）
    const isShortVid = (it) => /#shorts|ショート/i.test(it.title || '');
    const longPool = dedupedItems.filter(it => !isShortVid(it));
    let ranked = rankByRelevance(longPool, title, channel, { minScore: 1, limit: 24 });

    // 関連動画が少なすぎる場合のフォールバック（元動画タイトルでの検索結果を緩く採用）
    if (ranked.length < 8) {
      const pool = longPool.length >= 8 ? longPool : dedupedItems;
      const extra = pool.filter(it => !ranked.includes(it)).slice(0, 24 - ranked.length);
      ranked = [...ranked, ...extra];
    }

    const result = ranked;
    const payload = { items: result };
    // 関連動画は 10 分キャッシュ
    await cacheSet(cacheKey, payload, 10 * 60 * 1000);
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=120');
    // 視聴中の動画自身は除外して返す
    res.json({ items: result.filter(it => it && it.id !== id) });
  } catch (err) {
    console.error("Rec Engine Error:", err);
    res.json({ items: [] });
  }
});

app.get("/video/:id", async (req, res, next) => {
const videoId = req.params.id;
try {
let videoData = null;
let commentsData = { commentCount: 0, comments: [] };
let successfulApi = null;

const protocol = req.headers['x-forwarded-proto'] || 'http';
const host = req.headers.host;

for (const apiBase of apiListCache) {
  try {
    videoData = await Promise.any([
      fetchWithTimeout(`${apiBase}/api/video/${videoId}`, {}, 5000)
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(data => data.stream_url ? data : Promise.reject()),
      fetchWithTimeout(`${protocol}://${host}/sia-dl/${videoId}`, {}, 5000)
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(data => data.stream_url ? data : Promise.reject()),

      // 読み込み高速化のため、ai-fetch も遅延なしで並行リクエスト（一番速い応答を採用）
      fetchWithTimeout(`${protocol}://${host}/ai-fetch/${videoId}`, {}, 5000)
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(data => data.stream_url ? data : Promise.reject())
    ]);


    try {
      const cRes = await fetchWithTimeout(`${apiBase}/api/comments/${videoId}`, {}, 3000);
      if (cRes.ok) commentsData = await cRes.json();
    } catch (e) {}

    successfulApi = apiBase;
    break;

  } catch (e) {
    try {
      const rapidRes = await fetchWithTimeout(`${protocol}://${host}/rapid/${videoId}`, {}, 5000);
      if (rapidRes.ok) {
        const rapidData = await rapidRes.json();
        if (rapidData.stream_url) {
          videoData = rapidData;
          
          try {
            const cRes = await fetchWithTimeout(`${apiBase}/api/comments/${videoId}`, {}, 3000);
            if (cRes.ok) commentsData = await cRes.json();
          } catch (e) {}

          successfulApi = apiBase; 
          break; 
        }
      }
    } catch (rapidErr) {}
    continue;
  }
}

if (!videoData) {
  videoData = { videoTitle: "再生できない動画", stream_url: "youtube-nocookie" };
}

console.log(commentsData)
let isShortForm = videoData.videoTitle.includes('#');

if (isShortForm) {
    try {
        const shortCheckRes = await fetchWithTimeout(
            `${protocol}://${host}/short-check/${videoId}`,
            {},
            5000
        );

        if (shortCheckRes.ok) {
            const shortCheckData = await shortCheckRes.json();

            isShortForm = shortCheckData.isShort === true;
        } else {
            isShortForm = false;
        }

    } catch (e) {
        console.warn('ショート判定失敗:', e);
        isShortForm = false;
    }
}

    if (isShortForm) {
const shortsHtml = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${videoData.videoTitle}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; color: #fff; font-family: "Roboto", sans-serif; overflow: hidden; }
        .shorts-wrapper { position: relative; width: 100%; height: 100%; display: flex; justify-content: center; align-items: center; background: #000; }
        .video-container { position: relative; height: 94vh; aspect-ratio: 9/16; background: #000; border-radius: 12px; overflow: hidden; box-shadow: 0 0 20px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 10; }
        @media (max-width: 600px) { .video-container { height: 100%; width: 100%; border-radius: 0; } }
        /* 動画を常に最前面へ */
        video, iframe { width: 100%; height: 100%; object-fit: cover; border: none; position: relative; z-index: 11; visibility: hidden; }
        .progress-container { position: absolute; bottom: 0; left: 0; width: 100%; height: 2px; background: rgba(255,255,255,0.2); z-index: 25; }
        .progress-bar { height: 100%; background: #ff0000; width: 0%; transition: width 0.1s linear; }
        .bottom-overlay { position: absolute; bottom: 0; left: 0; width: 100%; padding: 100px 16px 24px; background: linear-gradient(transparent, rgba(0,0,0,0.8)); z-index: 20; pointer-events: none; }
        .bottom-overlay * { pointer-events: auto; }
        .channel-info { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        .channel-info img { width: 32px; height: 32px; border-radius: 50%; }
        .channel-name { font-weight: 500; font-size: 15px; }
        .subscribe-btn { background: #fff; color: #000; border: none; padding: 6px 12px; border-radius: 18px; font-size: 12px; font-weight: bold; cursor: pointer; margin-left: 8px; }
        .video-title { font-size: 14px; line-height: 1.4; margin-bottom: 8px; font-weight: 400; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .side-bar { position: absolute; right: 8px; bottom: 80px; display: flex; flex-direction: column; gap: 16px; align-items: center; z-index: 30; }
        .action-btn { display: flex; flex-direction: column; align-items: center; cursor: pointer; }
        .btn-icon { width: 44px; height: 44px; background: rgba(255,255,255,0.12); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: 0.2s; margin-bottom: 4px; }
        .btn-icon:active { transform: scale(0.9); background: rgba(255,255,255,0.25); }
        .action-btn span { font-size: 11px; text-shadow: 0 1px 2px rgba(0,0,0,0.8); font-weight: 400; }
        .swipe-hint { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.6); padding: 12px 20px; border-radius: 30px; display: flex; align-items: center; gap: 10px; z-index: 50; opacity: 0; pointer-events: none; transition: opacity 0.5s; border: 1px solid rgba(255,255,255,0.2); }
        .swipe-hint.show { opacity: 1; animation: bounce 2s infinite; }
        @keyframes bounce { 0%, 100% { transform: translate(-50%, -50%); } 50% { transform: translate(-50%, -60%); } }
        .comments-panel { position: absolute; bottom: 0; left: 0; width: 100%; height: 75%; background: #181818; border-radius: 16px 16px 0 0; z-index: 40; transform: translateY(100%); transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); display: flex; flex-direction: column; }
        .comments-panel.open { transform: translateY(0); }
        .comments-header { padding: 14px 16px; border-bottom: 1px solid #303030; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
        .comments-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
        .comments-header .count { color: #aaa; font-size: 13px; margin-left: 6px; font-weight: 400; }
        .comments-body { flex: 1; overflow-y: auto; padding: 16px; -webkit-overflow-scrolling: touch; }
        .comments-body::-webkit-scrollbar { width: 4px; }
        .comments-body::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
        .comment-item { display: flex; gap: 12px; margin-bottom: 18px; }
        .comment-avatar { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; background: #333; object-fit: cover; }
        .comment-body { flex: 1; min-width: 0; }
        .comment-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 2px; }
        .comment-author { font-size: 12px; color: #aaa; font-weight: 600; }
        .comment-author.is-creator { background: linear-gradient(90deg,#3ea6ff,#ff0080); color:#0f0f0f; padding: 1px 7px; border-radius: 10px; font-weight: 700; }
        .comment-time { font-size: 11px; color: #888; }
        .comment-pinned { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: #aaa; margin-bottom: 2px; }
        .comment-pinned i { font-size: 10px; }
        .comment-content { font-size: 14px; line-height: 1.4; word-wrap: break-word; white-space: pre-wrap; color: #fff; }
        .comment-actions { display: flex; align-items: center; gap: 4px; margin-top: 6px; }
        .comment-action-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 14px; background: transparent; border: none; color: #aaa; cursor: pointer; font-size: 11px; transition: background 0.15s; }
        .comment-action-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
        .comment-action-btn.active { color: #3ea6ff; }
        .comment-action-btn i { font-size: 13px; }
        .replies-toggle { display: inline-flex; align-items: center; gap: 6px; margin-top: 4px; padding: 6px 12px; border-radius: 14px; background: transparent; color: #3ea6ff; border: none; cursor: pointer; font-size: 12px; font-weight: 500; }
        .replies-toggle:hover { background: rgba(62,166,255,0.12); }
        .replies-toggle i { font-size: 10px; transition: transform 0.2s; }
        .replies-toggle.open i { transform: rotate(180deg); }
        .replies-container { margin-top: 10px; padding-left: 4px; display: none; flex-direction: column; gap: 12px; }
        .replies-container.open { display: flex; }
        .reply-item { display: flex; gap: 10px; }
        .reply-avatar { width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0; background: #333; object-fit: cover; }
        .reply-loading { color: #888; font-size: 12px; display: flex; align-items: center; gap: 8px; padding: 4px 0; }
        .reply-loading .mini-spinner { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.15); border-top-color: #3ea6ff; border-radius: 50%; animation: spin 0.8s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .comments-empty { text-align: center; color: #888; padding: 40px 16px; font-size: 14px; }
        .comments-empty i { font-size: 32px; margin-bottom: 10px; display: block; }
        .top-nav { position: absolute; top: 16px; left: 16px; z-index: 35; display: flex; align-items: center; color: white; text-decoration: none; }
        .top-nav i { font-size: 20px; filter: drop-shadow(0 0 4px rgba(0,0,0,0.5)); }
        .loading-screen { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; z-index: 100; display: flex; align-items: center; justify-content: center; opacity: 1; transition: 0.3s; }
        .loading-screen.fade { opacity: 0; pointer-events: none; }
    </style>
</head>
<body>
    <div id="loader" class="loading-screen"><i class="fas fa-circle-notch fa-spin fa-2x"></i></div>
    <div class="shorts-wrapper">
        <div class="video-container">
            <a href="/" class="top-nav"><i class="fas fa-arrow-left"></i></a>
            <div id="swipeHint" class="swipe-hint"><i class="fas fa-hand-pointer"></i><span>下にスワイプして次の動画へ移動</span></div>
            
            ${videoData.stream_url !== "youtube-nocookie" 
                ? `<video id="videoPlayer" data-src="${videoData.stream_url}" loop playsinline></video>` 
                : `<iframe id="videoIframe" data-src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&controls=0&loop=1&playlist=${videoId}&modestbranding=1&rel=0" allow="autoplay"></iframe>`}
            
            <div class="progress-container"><div id="progressBar" class="progress-bar"></div></div>
            <div class="side-bar">
                <div class="action-btn"><div class="btn-icon"><i class="fas fa-thumbs-up"></i></div><span>${videoData.likeCount || '評価'}</span></div>
                <div class="action-btn"><div class="btn-icon"><i class="fas fa-thumbs-down"></i></div><span>低評価</span></div>
                <div class="action-btn" onclick="toggleComments()"><div class="btn-icon"><i class="fas fa-comment-dots"></i></div><span>${commentsData.commentCount || 0}</span></div>
                <div class="action-btn"><div class="btn-icon"><i class="fas fa-share"></i></div><span>共有</span></div>
                <div class="action-btn"><div class="btn-icon" style="background:none;"><img src="${videoData.channelImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=random&color=fff&size=64&bold=true`}" style="width:30px; height:30px; border-radius:4px; border:2px solid #fff;" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=555&color=fff&size=64&bold=true'"></div></div>
            </div>
            <div class="bottom-overlay">
                <div class="channel-info"><img src="${videoData.channelImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=random&color=fff&size=64&bold=true`}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=555&color=fff&size=64&bold=true'"><a href="/channel/${encodeURIComponent(videoData.channelName)}" style="text-decoration:none;color:inherit;"><span class="channel-name">@${videoData.channelName}</span></a><button id="shortSubBtn" class="subscribe-btn" onclick="toggleShortSub()">登録</button></div>
                <div class="video-title">${videoData.videoTitle}</div>
            </div>
            <div id="commentsPanel" class="comments-panel">
                <div class="comments-header">
                    <h3>コメント<span class="count" id="shortsCommentCount">${commentsData.commentCount || 0}</span></h3>
                    <i class="fas fa-times" style="cursor:pointer; font-size:18px; padding:4px;" onclick="toggleComments()"></i>
                </div>
                <div class="comments-body" id="shortsCommentsBody"></div>
            </div>
        </div>
    </div>
    <script>
        let startY = 0;
        const loader = document.getElementById('loader');
        const commentsPanel = document.getElementById('commentsPanel');
        const swipeHint = document.getElementById('swipeHint');
        const progressBar = document.getElementById('progressBar');

        window.onload = async () => {
            // 設定から保存された再生方法を取得
            const savedMode = localStorage.getItem('playbackMode') || 'googlevideo';

            async function initShortsPlayer() {
                const videoEl = document.getElementById('videoPlayer');
                const iframeEl = document.getElementById('videoIframe');

                if (savedMode === 'youtube-nocookie') {
                    // youtube-nocookie: video要素があればiframeに差し替え
                    const targetIframe = iframeEl || document.createElement('iframe');
                    if (!iframeEl) {
                        targetIframe.id = 'videoIframe';
                        targetIframe.setAttribute('allow', 'autoplay');
                        targetIframe.setAttribute('allowfullscreen', '');
                        targetIframe.style.cssText = 'width:100%; height:100%; object-fit:cover; border:none; position:relative; z-index:11;';
                        if (videoEl) videoEl.replaceWith(targetIframe);
                        else document.querySelector('.video-container').insertBefore(targetIframe, document.querySelector('.progress-container'));
                    }
                    targetIframe.src = \`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&controls=0&loop=1&playlist=${videoId}&modestbranding=1&rel=0\`;
                    targetIframe.style.visibility = 'visible';

                } else if (savedMode !== 'googlevideo' && videoEl) {
                    // DL-Pro などその他のモード: エンドポイントからURLを取得して再生
                    const endpointMap = { 'DL-Pro': '/360/${videoId}' };
                    const endpoint = endpointMap[savedMode];
                    if (endpoint) {
                        try {
                            const res = await fetch(endpoint);
                            if (res.ok) {
                                const url = await res.text();
                                videoEl.src = url;
                                videoEl.style.visibility = 'visible';
                                videoEl.play().catch(() => {});
                                videoEl.ontimeupdate = () => { const p = (videoEl.currentTime / videoEl.duration) * 100; progressBar.style.width = p + '%'; };
                                return;
                            }
                        } catch (e) {
                            console.warn('ショート: エンドポイント取得失敗、googlevideoにフォールバック', e);
                        }
                    }
                    // フォールバック: googlevideo
                    if (videoEl.dataset.src) {
                        videoEl.src = videoEl.dataset.src;
                        videoEl.style.visibility = 'visible';
                        videoEl.play().catch(() => {});
                        videoEl.ontimeupdate = () => { const p = (videoEl.currentTime / videoEl.duration) * 100; progressBar.style.width = p + '%'; };
                    }

                } else {
                    // デフォルト: googlevideo (またはサーバーがnocookieを返した場合はiframe)
                    if (videoEl && videoEl.dataset.src) {
                        videoEl.src = videoEl.dataset.src;
                        videoEl.style.visibility = 'visible';
                        videoEl.play().catch(() => {});
                        videoEl.ontimeupdate = () => { const p = (videoEl.currentTime / videoEl.duration) * 100; progressBar.style.width = p + '%'; };
                    }
                    if (iframeEl && iframeEl.dataset.src) {
                        iframeEl.src = iframeEl.dataset.src;
                        iframeEl.style.visibility = 'visible';
                    }
                }
            }

            await initShortsPlayer();
            loader.classList.add('fade');
            swipeHint.classList.add('show');
            setTimeout(() => { swipeHint.classList.remove('show'); }, 300);
        };

        /* ===== コメントレンダリング (Shorts) ===== */
        const __SHORTS_COMMENTS_DATA = ${JSON.stringify(commentsData || { commentCount: 0, comments: [] })};
        const __SHORTS_VIDEO_ID = ${JSON.stringify(videoId)};
        let __shortsCommentsRendered = false;

        function shortsEscapeHtml(s) {
            if (s == null) return '';
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        }
        function shortsLinkify(text) {
            const esc = shortsEscapeHtml(text);
            return esc.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#3ea6ff;">$1</a>');
        }
        function shortsRelativeTime(c) {
            const text = c.publishedText || c.published_text || '';
            if (text) {
                const map = [
                    [/^(\\d+)\\s*seconds?\\s*ago/i, '$1秒前'],
                    [/^(\\d+)\\s*minutes?\\s*ago/i, '$1分前'],
                    [/^(\\d+)\\s*hours?\\s*ago/i, '$1時間前'],
                    [/^(\\d+)\\s*days?\\s*ago/i, '$1日前'],
                    [/^(\\d+)\\s*weeks?\\s*ago/i, '$1週間前'],
                    [/^(\\d+)\\s*months?\\s*ago/i, '$1か月前'],
                    [/^(\\d+)\\s*years?\\s*ago/i, '$1年前'],
                    [/\\(edited\\)/i, '(編集済み)'],
                ];
                let out = text;
                for (const [re, rep] of map) out = out.replace(re, rep);
                return out;
            }
            const ts = c.published || c.publishedTime;
            if (typeof ts === 'number') {
                const diff = Math.floor(Date.now()/1000) - ts;
                if (diff < 60) return diff + '秒前';
                if (diff < 3600) return Math.floor(diff/60) + '分前';
                if (diff < 86400) return Math.floor(diff/3600) + '時間前';
                if (diff < 86400*7) return Math.floor(diff/86400) + '日前';
                if (diff < 86400*30) return Math.floor(diff/(86400*7)) + '週間前';
                if (diff < 86400*365) return Math.floor(diff/(86400*30)) + 'か月前';
                return Math.floor(diff/(86400*365)) + '年前';
            }
            return '';
        }
        function shortsFormatLike(n) {
            if (!n || isNaN(n)) return '';
            if (n < 1000) return String(n);
            if (n < 10000) return (n/1000).toFixed(1).replace(/\\.0$/,'') + '千';
            if (n < 100000000) return (n/10000).toFixed(1).replace(/\\.0$/,'') + '万';
            return (n/100000000).toFixed(1).replace(/\\.0$/,'') + '億';
        }
        function shortsAvatar(c, size) {
            size = size || 32;
            const t = c && c.authorThumbnails;
            if (Array.isArray(t) && t.length > 0) {
                const sorted = t.slice().sort((a,b)=>Math.abs((a.width||0)-size)-Math.abs((b.width||0)-size));
                return sorted[0].url || '';
            }
            return 'https://ui-avatars.com/api/?name=' + encodeURIComponent((c&&c.author)||'U') + '&background=555&color=fff&size=64&bold=true';
        }
        function shortsRenderComment(c, isReply) {
            const avatar = shortsAvatar(c, isReply ? 22 : 32);
            const authorCls = c.authorIsChannelOwner ? 'comment-author is-creator' : 'comment-author';
            const time = shortsRelativeTime(c);
            const likes = shortsFormatLike(c.likeCount);
            const replyCount = (c.replies && (c.replies.replyCount || c.replies.commentCount)) || 0;
            const continuation = c.replies && c.replies.continuation;
            const commentId = c.commentId || c.id || (Math.random().toString(36).slice(2));
            const isPinned = !!c.isPinned;
            const creatorHeart = c.creatorHeart && (c.creatorHeart.creatorThumbnail || c.creatorHeart.creatorName);

            let h = '';
            if (isReply) {
                h += '<div class="reply-item">';
                h += '<img class="reply-avatar" src="' + shortsEscapeHtml(avatar) + '" loading="lazy">';
                h += '<div class="comment-body">';
            } else {
                h += '<div class="comment-item" data-comment-id="' + shortsEscapeHtml(commentId) + '">';
                h += '<img class="comment-avatar" src="' + shortsEscapeHtml(avatar) + '" loading="lazy">';
                h += '<div class="comment-body">';
                if (isPinned) h += '<div class="comment-pinned"><i class="fas fa-thumbtack"></i> 固定されたコメント</div>';
            }
            h += '<div class="comment-meta">';
            h += '<span class="' + authorCls + '">' + shortsEscapeHtml(c.author || '匿名') + '</span>';
            if (time) h += '<span class="comment-time">' + shortsEscapeHtml(time) + '</span>';
            h += '</div>';
            h += '<div class="comment-content">' + shortsLinkify(c.content || '') + '</div>';
            h += '<div class="comment-actions">';
            h += '<button class="comment-action-btn" onclick="shortsToggleLike(this)"><i class="far fa-thumbs-up"></i><span>' + shortsEscapeHtml(likes) + '</span></button>';
            h += '<button class="comment-action-btn" onclick="shortsToggleLike(this, true)"><i class="far fa-thumbs-down"></i></button>';
            if (creatorHeart) {
                h += '<span class="comment-action-btn" title="クリエイターのハート"><i class="fas fa-heart" style="color:#ff0033;"></i></span>';
            }
            h += '</div>';
            if (!isReply && replyCount > 0) {
                h += '<button class="replies-toggle" onclick="shortsToggleReplies(this, \\'' + shortsEscapeHtml(commentId) + '\\', ' + JSON.stringify(continuation || '') + ')">';
                h += '<i class="fas fa-chevron-down"></i><span>返信 ' + replyCount + ' 件</span>';
                h += '</button>';
                h += '<div class="replies-container" data-loaded="0"></div>';
            }
            h += '</div></div>';
            return h;
        }
        function shortsRenderComments() {
            if (__shortsCommentsRendered) return;
            __shortsCommentsRendered = true;
            const body = document.getElementById('shortsCommentsBody');
            if (!body) return;
            const data = __SHORTS_COMMENTS_DATA;
            if (!data.comments || data.comments.length === 0) {
                body.innerHTML = '<div class="comments-empty"><i class="far fa-comment"></i>コメントはまだありません</div>';
                return;
            }
            const sorted = data.comments.slice().sort((a,b) => {
                if (!!b.isPinned !== !!a.isPinned) return b.isPinned ? 1 : -1;
                return (b.likeCount || 0) - (a.likeCount || 0);
            });
            body.innerHTML = sorted.map(c => shortsRenderComment(c, false)).join('');
            const cntEl = document.getElementById('shortsCommentCount');
            if (cntEl) {
                const cnt = data.commentCount || data.comments.length;
                cntEl.textContent = (typeof cnt === 'number') ? cnt.toLocaleString() : cnt;
            }
        }
        function shortsToggleLike(btn, isDown) {
            const icon = btn.querySelector('i');
            const active = btn.classList.toggle('active');
            if (icon) {
                if (active) { icon.classList.remove('far'); icon.classList.add('fas'); }
                else { icon.classList.remove('fas'); icon.classList.add('far'); }
            }
        }
        async function shortsToggleReplies(btn, commentId, continuation) {
            const container = btn.parentElement.querySelector('.replies-container');
            if (!container) return;
            const isOpen = container.classList.contains('open');
            if (isOpen) {
                container.classList.remove('open');
                btn.classList.remove('open');
                return;
            }
            container.classList.add('open');
            btn.classList.add('open');
            if (container.dataset.loaded === '1') return;
            const myComment = (__SHORTS_COMMENTS_DATA.comments || []).find(x => (x.commentId || x.id) === commentId);
            if (myComment && myComment.replies && Array.isArray(myComment.replies.replies) && myComment.replies.replies.length > 0) {
                container.innerHTML = myComment.replies.replies.map(r => shortsRenderComment(r, true)).join('');
                container.dataset.loaded = '1';
                return;
            }
            if (!continuation) {
                container.innerHTML = '<div class="reply-loading">返信を取得できません</div>';
                container.dataset.loaded = '1';
                return;
            }
            container.innerHTML = '<div class="reply-loading"><div class="mini-spinner"></div>読み込み中...</div>';
            try {
                const r = await fetch('/api/comments-reply/' + __SHORTS_VIDEO_ID + '?continuation=' + encodeURIComponent(continuation));
                if (!r.ok) throw new Error('failed');
                const data = await r.json();
                const replies = data.comments || [];
                if (replies.length === 0) container.innerHTML = '<div class="reply-loading">返信はありません</div>';
                else container.innerHTML = replies.map(r => shortsRenderComment(r, true)).join('');
            } catch (e) {
                container.innerHTML = '<div class="reply-loading" style="color:#ff6b6b;">読み込み失敗</div>';
            }
            container.dataset.loaded = '1';
        }

        function toggleComments() {
            commentsPanel.classList.toggle('open');
            if (commentsPanel.classList.contains('open')) shortsRenderComments();
        }
        // チャンネル登録機能（ショート）
        const SHORT_CHANNEL = "${videoData.channelName || ''}";
        const SHORT_SUB_KEY = 'subscribed_' + SHORT_CHANNEL;
        const shortSubBtn = document.getElementById('shortSubBtn');
        function updateShortSubBtn() {
          const isSub = localStorage.getItem(SHORT_SUB_KEY) === 'true';
          shortSubBtn.textContent = isSub ? '登録済み' : '登録';
          shortSubBtn.style.background = isSub ? 'rgba(255,255,255,0.3)' : '#fff';
          shortSubBtn.style.color = isSub ? '#fff' : '#000';
        }
        function toggleShortSub() {
          const isSub = localStorage.getItem(SHORT_SUB_KEY) === 'true';
          if (isSub) {
            localStorage.removeItem(SHORT_SUB_KEY);
          } else {
            localStorage.setItem(SHORT_SUB_KEY, 'true');
            try {
              const meta = {
                name: SHORT_CHANNEL,
                avatar: ${JSON.stringify(videoData.channelImage || '')},
                subscribedAt: Date.now()
              };
              localStorage.setItem('subinfo_' + SHORT_CHANNEL, JSON.stringify(meta));
            } catch (e) {}
          }
          updateShortSubBtn();
        }
        updateShortSubBtn();
        async function loadNextShort() {
            if (commentsPanel.classList.contains('open')) return;
            loader.classList.remove('fade');
            try {
                const params = new URLSearchParams({ title: "${videoData.videoTitle}", channel: "${videoData.channelName}", id: "${videoId}" });
                const res = await fetch(\`/api/recommendations?\${params.toString()}\`);
                const data = await res.json();
                const nextShort = data.items.find(item => item.title.includes('#')) || data.items[0];
                if (nextShort) { window.location.href = '/video/' + nextShort.id; } else { window.location.href = '/'; }
            } catch (e) { window.location.href = '/'; }
        }
        window.addEventListener('touchstart', e => startY = e.touches[0].pageY);
        window.addEventListener('touchend', e => { const endY = e.changedTouches[0].pageY; if (startY - endY > 100) loadNextShort(); });
        window.addEventListener('wheel', e => { if (e.deltaY > 50) loadNextShort(); }, { passive: true });
        document.addEventListener('click', (e) => { if (commentsPanel.classList.contains('open') && !commentsPanel.contains(e.target) && !e.target.closest('.action-btn')) { toggleComments(); } });
    </script>
</body>
</html>`;
      return res.send(shortsHtml);
    }

    // --- STANDARD VIDEO MODE HTML ---
    // playerWrapper は空にして、クライアント側JSが localStorage.playbackMode に基づいて初期化する
const streamEmbedPlaceholder = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;"><div class="spinner"></div></div>`;

    const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${videoData.videoTitle} - YouTube Pro</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <script>
        /* テーマ適用(チラつき防止のため描画前に実行) — ホームと同じ 'theme' キーを共有 */
        (function() {
            try {
                if (localStorage.getItem('theme') === 'light') {
                    document.documentElement.classList.add('light-mode');
                }
            } catch (e) {}
        })();
    </script>
    <style>
        :root {
            --bg-main: #0f0f0f;
            --bg-elevated: #181818;
            --bg-secondary: #232323;
            --bg-hover: #303030;
            --text-main: #f1f1f1;
            --text-sub: #a0a0a0;
            --yt-red: #ff4d4d;
            --brand: #5aa9ff;
            --brand-soft: rgba(90,169,255,0.14);
            --brand-text: #0f0f0f;
            --border-soft: rgba(255,255,255,0.08);
            --surface-shadow: 0 8px 30px rgba(0,0,0,0.45);
            --radius-lg: 18px;
            --radius-md: 14px;
            --radius-pill: 999px;
            --ease: cubic-bezier(0.22, 1, 0.36, 1);
        }
        html.light-mode body, body.light-mode {
            --bg-main: #f7f8fa;
            --bg-elevated: #ffffff;
            --bg-secondary: #eef0f3;
            --bg-hover: #e2e6eb;
            --text-main: #14161a;
            --text-sub: #5e6470;
            --yt-red: #ff3b3b;
            --brand: #2f7df0;
            --brand-soft: rgba(47,125,240,0.10);
            --brand-text: #ffffff;
            --border-soft: rgba(0,0,0,0.07);
            --surface-shadow: 0 8px 26px rgba(20,30,50,0.10);
        }
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0; background: var(--bg-main); color: var(--text-main); font-family: "Roboto", "Helvetica Neue", "Arial", sans-serif; overflow-x: hidden; -webkit-font-smoothing: antialiased; transition: background 0.3s var(--ease), color 0.3s var(--ease); }
        .navbar { position: fixed; top: 0; width: 100%; height: 60px; background: color-mix(in srgb, var(--bg-main) 82%, transparent); backdrop-filter: saturate(140%) blur(14px); -webkit-backdrop-filter: saturate(140%) blur(14px); display: flex; align-items: center; justify-content: space-between; padding: 0 20px; box-sizing: border-box; z-index: 1000; border-bottom: 1px solid var(--border-soft); }
        .nav-left { display: flex; align-items: center; gap: 16px; }
        .logo { display: flex; align-items: center; gap: 8px; color: var(--text-main); text-decoration: none; font-weight: 700; font-size: 19px; letter-spacing: -0.3px; }
        .logo i { color: var(--yt-red); font-size: 24px; margin-right: 2px; }
        .nav-center { flex: 0 1 600px; display: flex; position: relative; }
        .search-bar { display: flex; width: 100%; background: var(--bg-secondary); border: 1px solid var(--border-soft); border-radius: var(--radius-pill); padding: 0 8px 0 18px; transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease); }
        .search-bar:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
        .search-bar input { width: 100%; background: transparent; border: none; color: var(--text-main); height: 42px; font-size: 15px; outline: none; }
        .search-bar input::placeholder { color: var(--text-sub); }
        .search-btn { background: transparent; border: none; border-radius: var(--radius-pill); width: 48px; height: 42px; color: var(--text-sub); cursor: pointer; transition: color 0.2s var(--ease); }
        .search-btn:hover { color: var(--text-main); }
        .autocomplete-dropdown { position: absolute; top: calc(100% + 8px); left: 0; width: 100%; background: var(--bg-elevated); border-radius: var(--radius-md); box-shadow: var(--surface-shadow); z-index: 2000; overflow: hidden; display: none; padding: 10px 0; border: 1px solid var(--border-soft); }
        .autocomplete-item { padding: 9px 18px; display: flex; align-items: center; gap: 12px; cursor: pointer; color: var(--text-main); font-size: 15px; transition: background 0.15s var(--ease); }
        .autocomplete-item:hover { background: var(--bg-hover); }
        .autocomplete-item i { color: var(--text-sub); font-size: 14px; }
        .container { margin-top: 60px; display: flex; justify-content: center; padding: 28px; gap: 28px; max-width: 1700px; margin-left: auto; margin-right: auto; }
        .main-content { flex: 1; min-width: 0; position: relative; }
        .sidebar { width: 400px; flex-shrink: 0; }
        .player-container { width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: var(--radius-lg); overflow: hidden; position: relative; z-index: 100; box-shadow: var(--surface-shadow); }
        .video-title { font-size: 21px; font-weight: 700; margin: 18px 0 12px; line-height: 1.35; letter-spacing: -0.3px; }
        .owner-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
        .owner-info { display: flex; align-items: center; gap: 12px; }
        .owner-info img { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; }
        .channel-name { font-weight: 600; font-size: 16px; }
        .btn-sub { background: var(--text-main); color: var(--bg-main); border: none; padding: 0 18px; height: 38px; border-radius: var(--radius-pill); font-weight: 600; cursor: pointer; }
        .action-btn { background: var(--bg-secondary); border: 1px solid var(--border-soft); color: var(--text-main); padding: 0 16px; height: 38px; border-radius: var(--radius-pill); cursor: pointer; font-size: 14px; }
        .description-box { background: var(--bg-secondary); border: 1px solid var(--border-soft); border-radius: var(--radius-md); padding: 14px 16px; font-size: 14px; margin-bottom: 24px; cursor: pointer; transition: background 0.2s var(--ease); }
        .description-box:hover { background: var(--bg-hover); }
        .description-content { max-height: 60px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; margin-top: 8px; line-height: 1.5; }
        .description-box.expanded .description-content { max-height: none; -webkit-line-clamp: unset; display: block; }
        .description-show-more { font-weight: bold; margin-top: 8px; font-size: 14px; }
        /* === コメントセクション === */
        .comments-section { margin-top: 24px; }
        .comments-section h3 { font-size: 18px; font-weight: 600; margin: 0 0 16px; display: flex; align-items: center; gap: 16px; }
        .comments-toolbar { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; font-size: 14px; color: var(--text-sub); }
        .comments-sort { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; padding: 6px 10px; border-radius: 18px; transition: background 0.15s; user-select: none; }
        .comments-sort:hover { background: var(--bg-secondary); color: var(--text-main); }
        .comments-sort i { font-size: 12px; }
        .comments-list { display: flex; flex-direction: column; }
        .comment-item { display: flex; gap: 14px; margin-bottom: 20px; }
        .comment-avatar { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; background: var(--bg-secondary); object-fit: cover; }
        .comment-body { flex: 1; min-width: 0; }
        .comment-meta-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
        .comment-author { font-weight: 500; font-size: 13px; color: var(--text-main); }
        .comment-author.is-creator { background: linear-gradient(90deg,var(--brand),#ff5fa2); color:#fff; padding: 2px 8px; border-radius: 12px; font-weight: 600; }
        .comment-time { font-size: 12px; color: var(--text-sub); }
        .comment-pinned { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-sub); margin-bottom: 4px; }
        .comment-pinned i { font-size: 11px; }
        .comment-content { font-size: 14px; line-height: 1.45; color: var(--text-main); word-wrap: break-word; white-space: pre-wrap; }
        .comment-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--text-sub); }
        .comment-action-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 18px; cursor: pointer; user-select: none; transition: background 0.15s; background: transparent; border: none; color: var(--text-sub); font-size: 12px; }
        .comment-action-btn:hover { background: var(--bg-secondary); color: var(--text-main); }
        .comment-action-btn.active { color: #3ea6ff; }
        .comment-action-btn i { font-size: 14px; }
        .comment-likes { font-size: 12px; color: var(--text-sub); min-width: 12px; }
        .comment-creator-heart { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: var(--yt-red); color: #fff; font-size: 10px; margin-left: -10px; margin-top: 14px; align-self: flex-start; }
        .replies-toggle { display: inline-flex; align-items: center; gap: 8px; margin-top: 6px; padding: 8px 14px; border-radius: 18px; background: transparent; color: #3ea6ff; border: none; cursor: pointer; font-size: 13px; font-weight: 500; transition: background 0.15s; }
        .replies-toggle:hover { background: rgba(62,166,255,0.12); }
        .replies-toggle i { font-size: 11px; transition: transform 0.2s; }
        .replies-toggle.open i { transform: rotate(180deg); }
        .replies-container { margin-top: 12px; padding-left: 4px; display: none; flex-direction: column; gap: 16px; }
        .replies-container.open { display: flex; }
        .reply-item { display: flex; gap: 12px; }
        .reply-avatar { width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0; background: #333; object-fit: cover; }
        .reply-loading { padding: 8px 0; color: var(--text-sub); font-size: 13px; display: flex; align-items: center; gap: 8px; }
        .reply-loading .mini-spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.15); border-top-color: #3ea6ff; border-radius: 50%; animation: spin 0.8s linear infinite; }
        .comments-empty { text-align: center; color: var(--text-sub); padding: 32px 0; font-size: 14px; }
        .comments-load-more { background: transparent; color: #3ea6ff; border: 1px solid #3ea6ff; padding: 10px 20px; border-radius: 20px; cursor: pointer; font-size: 14px; font-weight: 500; margin: 12px auto; display: block; transition: background 0.15s; }
        .comments-load-more:hover { background: rgba(62,166,255,0.12); }
        .rec-item { display: flex; gap: 10px; margin-bottom: 14px; cursor: pointer; text-decoration: none; color: inherit; padding: 6px; border-radius: var(--radius-md); transition: background 0.18s var(--ease); }
        .rec-item:hover { background: var(--bg-secondary); }
        .rec-thumb { width: 168px; height: 94px; flex-shrink: 0; border-radius: 12px; overflow: hidden; background: var(--bg-secondary); }
        .rec-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .rec-info { display: flex; flex-direction: column; justify-content: flex-start; }
        .rec-title { font-size: 14px; font-weight: bold; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 4px; }
        .rec-meta { font-size: 12px; color: var(--text-sub); margin-top: 2px; }
        .shorts-shelf-container { margin-top: 24px; border-top: 4px solid var(--bg-secondary); padding-top: 20px; margin-bottom: 24px; }
        .shorts-shelf-title { display: flex; align-items: center; font-size: 18px; font-weight: bold; margin-bottom: 16px; color: white; }
        .shorts-shelf-title svg { margin-right: 8px; width: 24px; height: 24px; }
        .shorts-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
        .short-card { text-decoration: none; color: inherit; display: block; }
        .short-thumb { aspect-ratio: 9/16; border-radius: 8px; overflow: hidden; background: #222; }
        .short-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .short-info { margin-top: 8px; }
        .short-title { font-size: 14px; font-weight: 500; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .short-views { font-size: 12px; color: var(--text-sub); margin-top: 4px; }
        .server-dropdown-container { position: relative; display: inline-block; margin-left: 12px; }
        .btn-server { background: var(--bg-secondary); color: var(--text-main); border: 1px solid var(--border-soft); padding: 0 16px; height: 38px; border-radius: var(--radius-pill); font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 14px; transition: background 0.2s var(--ease); }
        .btn-server:hover { background: var(--bg-hover); }
        .server-menu { display: none; position: absolute; top: 100%; left: 0; margin-top: 8px; background: var(--bg-elevated); border-radius: var(--radius-md); overflow: hidden; box-shadow: var(--surface-shadow); z-index: 200; min-width: 220px; border: 1px solid var(--border-soft); }
        .server-menu.show { display: block; }
        .server-option { padding: 12px 16px; cursor: pointer; font-size: 14px; transition: background 0.2s; display: flex; align-items: center; }
        .server-option:hover { background: var(--bg-hover); }
        .server-option.active { background: var(--brand-soft); border-left: 4px solid var(--brand); padding-left: 12px; }
        .video-loading-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.7); z-index: 150; display: flex; flex-direction: column; align-items: center; justify-content: center; color: white; opacity: 0; pointer-events: none; transition: opacity 0.3s ease; backdrop-filter: blur(2px); }
        .video-loading-overlay.active { opacity: 1; pointer-events: auto; }
        .spinner { border: 4px solid rgba(255, 255, 255, 0.1); width: 50px; height: 50px; border-radius: 50%; border-top-color: var(--yt-red); animation: spin 1s ease-in-out infinite; margin-bottom: 16px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        @media (max-width: 1000px) { .container { flex-direction: column; padding: 0; } .sidebar { width: 100%; padding: 16px; box-sizing: border-box; } .player-container { border-radius: 0; } .main-content { padding: 16px; } }

        /* === シアターモード === */
        body.theater-mode { overflow-x: hidden; }
        body.theater-mode .container { max-width: 100%; padding: 0; flex-direction: column; gap: 0; }
        body.theater-mode .main-content { flex: none; width: 100%; padding: 0; }
        body.theater-mode .player-container { width: 100%; max-width: 100%; aspect-ratio: auto; height: min(85vh, calc(100vw * 9/16)); border-radius: 0; }
        body.theater-mode .video-title,
        body.theater-mode .owner-row,
        body.theater-mode .description-box,
        body.theater-mode .comments-section,
        body.theater-mode .hashtag-bar { max-width: 1700px; margin-left: auto; margin-right: auto; padding-left: 24px; padding-right: 24px; box-sizing: border-box; }
        body.theater-mode .sidebar { width: 100%; max-width: 1700px; margin: 0 auto; padding: 24px; box-sizing: border-box; }
        @media (max-width: 1000px) {
          body.theater-mode .video-title,
          body.theater-mode .owner-row,
          body.theater-mode .description-box,
          body.theater-mode .comments-section,
          body.theater-mode .hashtag-bar,
          body.theater-mode .sidebar { padding-left: 16px; padding-right: 16px; }
        }

        /* === 関連ハッシュタグ === */
        .hashtag-bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 14px; }
        .hashtag-chip { background: var(--bg-secondary); color: var(--brand); padding: 6px 12px; border-radius: var(--radius-pill); font-size: 13px; font-weight: 500; text-decoration: none; transition: background 0.15s ease; border: 1px solid var(--border-soft); }
        .hashtag-chip:hover { background: var(--brand-soft); }
        .hashtag-bar:empty { display: none; }

        /* === 動画下部アクション拡張 === */
        .action-btn.toggle-on { background: var(--brand); color: var(--brand-text); border-color: transparent; }
        .download-menu-wrap { position: relative; display: inline-block; }
        .download-menu { display: none; position: absolute; right: 0; top: calc(100% + 6px); background: var(--bg-elevated); border-radius: var(--radius-md); min-width: 220px; box-shadow: var(--surface-shadow); z-index: 250; overflow: hidden; border: 1px solid var(--border-soft); }
        .download-menu.show { display: block; }
        .download-menu .dm-header { padding: 10px 14px; font-size: 12px; color: var(--text-sub); border-bottom: 1px solid var(--border-soft); }
        .download-menu a { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; color: var(--text-main); text-decoration: none; font-size: 14px; transition: background 0.15s; }
        .download-menu a:hover { background: var(--bg-hover); }
        .download-menu a .dm-badge { font-size: 11px; color: var(--text-sub); }
        .download-menu .dm-empty { padding: 12px 14px; font-size: 13px; color: var(--text-sub); }
        .action-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

        /* === 自動再生ピル === */
        .autoplay-pill { display: inline-flex; align-items: center; gap: 8px; background: var(--bg-secondary); color: var(--text-main); padding: 6px 12px; height: 38px; box-sizing: border-box; border-radius: var(--radius-pill); cursor: pointer; font-size: 13px; user-select: none; border: 1px solid var(--border-soft); transition: background 0.18s var(--ease); }
        .autoplay-pill.on { background: var(--brand); color: var(--brand-text); }
        .autoplay-switch { width: 28px; height: 16px; background: #888; border-radius: 16px; position: relative; transition: background 0.2s; }
        .autoplay-pill.on .autoplay-switch { background: var(--brand-text); }
        .autoplay-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: left 0.2s; }
        .autoplay-pill.on .autoplay-switch::after { left: 14px; }

        /* === 自動次へカウントダウン === */
        .next-up-overlay { position: absolute; right: 16px; bottom: 16px; background: rgba(0,0,0,0.85); color: #fff; padding: 12px 14px; border-radius: 10px; z-index: 200; display: none; max-width: 280px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); border: 1px solid #444; }
        .next-up-overlay.show { display: block; }
        .next-up-overlay .nu-label { font-size: 11px; color: #aaa; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
        .next-up-overlay .nu-title { font-size: 13px; font-weight: 500; line-height: 1.3; margin-bottom: 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .next-up-overlay .nu-actions { display: flex; gap: 6px; }
        .next-up-overlay button { flex: 1; background: #272727; color: #fff; border: none; padding: 6px 8px; font-size: 12px; border-radius: 6px; cursor: pointer; }
        .next-up-overlay button.primary { background: var(--brand); color: var(--brand-text); font-weight: bold; }
        .next-up-overlay .nu-progress { height: 3px; background: rgba(255,255,255,0.15); border-radius: 2px; margin: 8px 0; overflow: hidden; }
        .next-up-overlay .nu-progress-bar { height: 100%; background: var(--brand); width: 100%; transition: width 0.2s linear; }

        /* === v1.4.0 デザイン刷新：アクションバー === */
        .video-title { letter-spacing: 0.2px; }
        .owner-row { gap: 16px; flex-wrap: wrap; }
        .btn-sub { transition: transform 0.15s ease, background 0.2s ease, color 0.2s ease; }
        .btn-sub:hover { transform: translateY(-1px); }
        .btn-sub:active { transform: scale(0.97); }
        .action-btn { display: inline-flex; align-items: center; gap: 8px; transition: background 0.18s ease, transform 0.15s ease, color 0.18s ease; }
        .action-btn:hover { background: var(--bg-hover); transform: translateY(-1px); }
        .action-btn:active { transform: scale(0.97); }
        .action-btn i { font-size: 14px; }
        .action-toolbar { gap: 10px; }
        /* 保存(再生リスト)ボタンが追加済みのときの強調 */
        .action-btn.saved { background: var(--brand); color: var(--brand-text); border-color: transparent; }
        .action-btn.saved i { color: var(--brand-text); }

        /* === v1.4.0：再生リスト保存モーダル === */
        .pl-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); backdrop-filter: blur(6px); z-index: 3000; display: none; align-items: center; justify-content: center; padding: 16px; }
        .pl-modal-overlay.open { display: flex; animation: plFade 0.18s ease; }
        @keyframes plFade { from { opacity: 0; } to { opacity: 1; } }
        .pl-modal { width: 100%; max-width: 420px; background: var(--bg-elevated); border: 1px solid var(--border-soft); border-radius: var(--radius-lg); box-shadow: 0 24px 60px rgba(0,0,0,0.45); overflow: hidden; animation: plPop 0.2s cubic-bezier(0.34,1.56,0.64,1); }
        @keyframes plPop { from { transform: translateY(12px) scale(0.96); opacity: 0; } to { transform: none; opacity: 1; } }
        .pl-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px 12px; }
        .pl-modal-head h3 { margin: 0; font-size: 17px; font-weight: 600; }
        .pl-modal-close { background: transparent; border: none; color: var(--text-sub); font-size: 18px; cursor: pointer; width: 34px; height: 34px; border-radius: 50%; transition: background 0.15s; }
        .pl-modal-close:hover { background: var(--bg-hover); color: var(--text-main); }
        .pl-modal-body { padding: 0 20px 8px; max-height: 46vh; overflow-y: auto; }
        .pl-modal-body::-webkit-scrollbar { width: 6px; }
        .pl-modal-body::-webkit-scrollbar-thumb { background: var(--bg-hover); border-radius: 4px; }
        .pl-item { display: flex; align-items: center; gap: 12px; padding: 12px 10px; border-radius: 10px; cursor: pointer; transition: background 0.15s; }
        .pl-item:hover { background: var(--bg-hover); }
        .pl-item .pl-check { width: 22px; height: 22px; border-radius: 6px; border: 2px solid var(--text-sub); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 12px; color: var(--brand-text); transition: background 0.15s, border-color 0.15s; }
        .pl-item.added .pl-check { background: var(--brand); border-color: var(--brand); }
        .pl-item .pl-meta { flex: 1; min-width: 0; }
        .pl-item .pl-name { font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .pl-item .pl-count { font-size: 12px; color: var(--text-sub); margin-top: 2px; }
        .pl-empty { text-align: center; color: var(--text-sub); font-size: 14px; padding: 18px 0; }
        .pl-create { padding: 12px 20px 20px; border-top: 1px solid var(--border-soft); margin-top: 8px; }
        .pl-create-label { font-size: 12px; color: var(--text-sub); margin-bottom: 8px; }
        .pl-create-row { display: flex; gap: 8px; }
        .pl-create-row input { flex: 1; background: var(--bg-secondary); border: 1px solid var(--border-soft); border-radius: 10px; color: var(--text-main); padding: 0 14px; height: 42px; font-size: 14px; outline: none; transition: border-color 0.15s; }
        .pl-create-row input:focus { border-color: var(--brand); }
        .pl-create-row button { background: var(--brand); color: var(--brand-text); border: none; border-radius: 10px; padding: 0 18px; height: 42px; font-weight: 700; cursor: pointer; font-size: 14px; transition: filter 0.15s, transform 0.15s; white-space: nowrap; }
        .pl-create-row button:hover { filter: brightness(1.08); }
        .pl-create-row button:active { transform: scale(0.97); }
        .pl-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--bg-elevated); color: var(--text-main); border: 1px solid var(--border-soft); padding: 12px 20px; border-radius: var(--radius-pill); z-index: 4000; font-size: 14px; box-shadow: var(--surface-shadow); display: flex; align-items: center; gap: 8px; opacity: 0; transition: opacity 0.2s, transform 0.2s; pointer-events: none; }
        .pl-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
        .pl-toast i { color: var(--brand); }
    </style>
</head>
<body>
<script>(function(){try{if(localStorage.getItem('theme')==='light'){document.body.classList.add('light-mode');}}catch(e){}})();</script>
<nav class="navbar">
    <div class="nav-left"><a href="/" class="logo"><i class="fab fa-youtube"></i>YouTube Pro</a></div>
    <div class="nav-center">
        <form class="search-bar" action="/nothing/search">
            <input type="text" name="q" id="searchInput" placeholder="検索" autocomplete="off">
            <button type="submit" class="search-btn"><i class="fas fa-search"></i></button>
        </form>
        <div id="autocompleteDropdown" class="autocomplete-dropdown"></div>
    </div>
    <div style="width:100px;"></div>
</nav>

<div class="container">
    <div class="main-content">
        <div class="player-container">
            <div id="playerWrapper" style="width:100%; height:100%;">
                ${streamEmbedPlaceholder}
            </div>
            <div id="videoLoadingOverlay" class="video-loading-overlay">
                <div class="spinner"></div>
                <div style="font-weight: bold; font-size: 16px;">動画サーバーに接続中...</div>
            </div>
        </div>
        <h1 class="video-title">${videoData.videoTitle}</h1>
        <div id="hashtagBar" class="hashtag-bar"></div>
        <div class="owner-row">
            <div class="owner-info">
                <a href="/channel/${encodeURIComponent(videoData.channelName)}" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;">
                  <img id="ownerAvatar" src="${videoData.channelImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=random&color=fff&size=80&bold=true`}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(videoData.channelName||'C')}&background=555&color=fff&size=80&bold=true'">
                  <div class="channel-name">${videoData.channelName}</div>
                </a>
                <button id="subBtn" class="btn-sub" onclick="toggleSubscribeVideo()">チャンネル登録</button>
                <div class="server-dropdown-container">
                    <button class="btn-server" onclick="toggleServerMenu()">
                        <i class="fas fa-server"></i> 動画サーバー <i class="fas fa-chevron-down" style="font-size: 12px; margin-left: 2px;"></i>
                    </button>
                    <div id="serverMenu" class="server-menu">
                        <div class="server-option active" onclick="changeServer('googlevideo', '', event)">Googlevideo</div>
                        <div class="server-option" onclick="changeServer('youtube-nocookie', '/nocookie/${videoId}', event)">Youtube-nocookie</div>
                        <div class="server-option" onclick="changeServer('DL-Pro', '/360/${videoId}', event)">DL-Pro</div>
                        <div class="server-option" onclick="changeServer('YoutubeEdu-Kahoot', '/kahoot-edu/${videoId}', event)">YoutubeEdu-Kahoot</div>
                        <div class="server-option" onclick="changeServer('YoutubeEdu-Scratch', '/scratch-edu/${videoId}', event)">YoutubeEdu-Scratch</div>
                        <div class="server-option" onclick="changeServer('Youtube-Pro', '/pro-stream/${videoId}', event)">Youtube-Pro</div>
                    </div>
                </div>
            </div>
            <div class="action-toolbar">
                <div id="autoplayPill" class="autoplay-pill" onclick="toggleAutoplay()" title="動画終了時に自動で次の動画を再生します">
                    <span>自動再生</span>
                    <span class="autoplay-switch"></span>
                </div>
                <button class="action-btn" id="theaterBtn" onclick="toggleTheaterMode()" title="シアターモード (T)"><i class="fas fa-tv"></i> シアター</button>
                <div class="download-menu-wrap">
                    <button class="action-btn" id="downloadBtn" onclick="toggleDownloadMenu(event)" title="ダウンロード"><i class="fas fa-download"></i> 保存</button>
                    <div class="download-menu" id="downloadMenu">
                        <div class="dm-header">ダウンロードリンク</div>
                        <div id="downloadMenuList"><div class="dm-empty">取得中...</div></div>
                    </div>
                </div>
                <button class="action-btn" id="savePlBtn" onclick="openPlaylistModal()" title="再生リストに保存"><i class="fas fa-bookmark"></i> 保存</button>
                <button class="action-btn">👍 ${videoData.likeCount || 0}</button>
                <button class="action-btn" onclick="shareVideo()"><i class="fas fa-share"></i> 共有</button>
            </div>
        </div>
        <div id="nextUpOverlay" class="next-up-overlay" aria-live="polite">
            <div class="nu-label">次の動画</div>
            <div class="nu-title" id="nuTitle"></div>
            <div class="nu-progress"><div class="nu-progress-bar" id="nuProgressBar"></div></div>
            <div class="nu-actions">
                <button id="nuCancelBtn" onclick="cancelAutoNext()">キャンセル</button>
                <button class="primary" id="nuPlayBtn" onclick="playAutoNextNow()">今すぐ再生</button>
            </div>
        </div>
        <div class="description-box" id="descriptionBox" onclick="toggleDescription(event)">
            <b>${videoData.videoViews || '0'} 回視聴</b>
            <div class="description-content" id="descriptionContent">
                ${(videoData.videoDes || '').replace(/\r\n|\n|\r/g, '<br>')}
            </div>
            <div class="description-show-more" id="descriptionToggleBtn">全文を表示</div>
        </div>
        <div class="comments-section">
            <h3>
                <span>コメント <span id="commentCountLabel">${commentsData.commentCount || 0}</span> 件</span>
            </h3>
            <div class="comments-toolbar">
                <div class="comments-sort" id="commentsSortBtn" onclick="toggleCommentSort()">
                    <i class="fas fa-sort"></i>
                    <span id="commentsSortLabel">人気順</span>
                </div>
            </div>
            <div id="commentsList" class="comments-list"></div>
        </div>
    </div>
    <div class="sidebar">
        <div id="recommendations"></div>
        <div id="shortsShelf" class="shorts-shelf-container" style="display:none;">
            <div class="shorts-shelf-title">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="red">
                    <path d="M17.77,10.32l-1.2-.5L18,9.06a3.74,3.74,0,0,0-3.5-6.62L6,6.94a3.74,3.74,0,0,0,.23,6.74l1.2.49L6,14.93a3.75,3.75,0,0,0,3.5,6.63l8.5-4.5a3.74,3.74,0,0,0-.23-6.74Z"/>
                    <polygon points="10 14.65 15 12 10 9.35 10 14.65" fill="#fff"/>
                </svg>
                Shorts
            </div>
            <div id="shortsGrid" class="shorts-grid"></div>
        </div>
    </div>
</div>

<!-- v1.4.0：再生リスト保存モーダル -->
<div id="plModalOverlay" class="pl-modal-overlay" onclick="if(event.target===this)closePlaylistModal()">
    <div class="pl-modal" role="dialog" aria-modal="true" aria-label="再生リストに保存">
        <div class="pl-modal-head">
            <h3><i class="fas fa-bookmark" style="color:#3ea6ff;margin-right:8px;"></i>再生リストに保存</h3>
            <button class="pl-modal-close" onclick="closePlaylistModal()" aria-label="閉じる"><i class="fas fa-times"></i></button>
        </div>
        <div class="pl-modal-body" id="plModalList"></div>
        <div class="pl-create">
            <div class="pl-create-label">新しい再生リストを作成</div>
            <div class="pl-create-row">
                <input type="text" id="plNewName" placeholder="再生リスト名" maxlength="40" autocomplete="off">
                <button onclick="createPlaylistAndAdd()">作成して追加</button>
            </div>
        </div>
    </div>
</div>
<div id="plToast" class="pl-toast"></div>

<script>
    function toggleServerMenu() { document.getElementById('serverMenu').classList.toggle('show'); }
    window.addEventListener('click', function(e) { if (!e.target.closest('.server-dropdown-container')) { const menu = document.getElementById('serverMenu'); if (menu && menu.classList.contains('show')) menu.classList.remove('show'); } });

    const VIDEO_CHANNEL = ${JSON.stringify(videoData.channelName || '')};
    const SUB_KEY_VIDEO = 'subscribed_' + VIDEO_CHANNEL;
    const subBtn = document.getElementById('subBtn');
    function updateSubBtnUI() {
      const isSub = localStorage.getItem(SUB_KEY_VIDEO) === 'true';
      if (isSub) {
        subBtn.textContent = '登録済み';
        subBtn.style.background = '#272727';
        subBtn.style.color = '#aaa';
      } else {
        subBtn.textContent = 'チャンネル登録';
        subBtn.style.background = 'white';
        subBtn.style.color = 'black';
      }
    }
    function toggleSubscribeVideo() {
      const isSub = localStorage.getItem(SUB_KEY_VIDEO) === 'true';
      if (isSub) {
        localStorage.removeItem(SUB_KEY_VIDEO);
      } else {
        localStorage.setItem(SUB_KEY_VIDEO, 'true');
        // メタ情報も保存
        try {
          const meta = {
            name: VIDEO_CHANNEL,
            avatar: ${JSON.stringify(videoData.channelImage || '')},
            subscribedAt: Date.now()
          };
          localStorage.setItem('subinfo_' + VIDEO_CHANNEL, JSON.stringify(meta));
        } catch (e) {}
      }
      updateSubBtnUI();
    }
    updateSubBtnUI();

    async function changeServer(serverName, endpointPath, event) {
        // --- 修正箇所：サーバー名を localStorage に保存 ---
        localStorage.setItem('playbackMode', serverName);

        document.getElementById('serverMenu').classList.remove('show');
        const options = document.querySelectorAll('.server-option');
        options.forEach(opt => opt.classList.remove('active'));
        
        // メニュー上の active 状態を同期
        if (event && event.currentTarget) {
            event.currentTarget.classList.add('active');
        } else {
            // 自動起動時などは文字列検索で active を付与
            options.forEach(opt => {
               if (opt.getAttribute('onclick').includes("'" + serverName + "'")) opt.classList.add('active');
            });
        }

        const overlay = document.getElementById('videoLoadingOverlay');
        overlay.classList.add('active');

        try {
            let newUrl = '';
            if (serverName === 'googlevideo') {
                newUrl = "${videoData.stream_url}" === "youtube-nocookie" ? \`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1\` : "${videoData.stream_url}";
            } else if (serverName === 'Youtube-Pro') {
                newUrl = endpointPath;
            } else {
                const res = await fetch(endpointPath);
                if (!res.ok) throw new Error("サーバーエラー");
                newUrl = await res.text();
            }

            const playerContainer = document.getElementById('playerWrapper');
            const forceIframe = ['YoutubeEdu-Kahoot', 'YoutubeEdu-Scratch', 'Youtube-Pro', 'youtube-nocookie'].includes(serverName);
            const isIframe = forceIframe || newUrl.includes('embed');

            let playerHtml = '';
            if (isIframe) {
                playerHtml = \`<iframe id="mainIframe" src="\${newUrl}" frameborder="0" allowfullscreen style="width:100%; height:100%; position:relative; z-index:10;"></iframe>\`;
            } else {
                playerHtml = \`<video id="mainPlayer" controls autoplay style="width:100%; height:100%; position:relative; z-index:10; background:#000;"><source src="\${newUrl}" type="video/mp4"></video>\`;
            }
            playerContainer.innerHTML = playerHtml;
            const newVideo = document.getElementById('mainPlayer');
            if (newVideo) { 
                newVideo.load(); 
                newVideo.play().catch(e => console.log("Auto")); 

                if (serverName === 'googlevideo' && !window.googlevideoReloaded) {
                    window.googlevideoReloaded = true;
                    setTimeout(() => {
                        const vid = document.getElementById('mainPlayer');
                        if (vid) {
                            const currentTime = vid.currentTime;
                            const isPlaying = !vid.paused;
                            vid.load();
                            vid.currentTime = currentTime;
                            if (isPlaying) vid.play().catch(e => {});
                        }
                    }, 2000);
                }
            }
        } catch (error) { console.error(error); } finally { overlay.classList.remove('active'); }
    }

    /* ======================================================
     * コメントレンダリング
     * ====================================================== */
    const __COMMENTS_DATA = ${JSON.stringify(commentsData || { commentCount: 0, comments: [] })};
    const __VIDEO_ID_FOR_COMMENTS = ${JSON.stringify(videoId)};
    let __commentSortMode = 'top'; // 'top' or 'new'

    function escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function linkifyText(text) {
        // 改行は white-space:pre-wrap で表現するので、URLだけリンク化
        const escaped = escapeHtml(text);
        return escaped.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#3ea6ff;">$1</a>');
    }
    function formatRelativeTime(c) {
        // Invidious 系: published(秒) と publishedText("3 days ago" など)
        // 既に publishedText があればそれを優先して日本語化
        const text = c.publishedText || c.published_text || '';
        if (text) {
            // 英語表現を日本語に変換
            const map = [
                [/^(\\d+)\\s*seconds?\\s*ago/i, '$1秒前'],
                [/^(\\d+)\\s*minutes?\\s*ago/i, '$1分前'],
                [/^(\\d+)\\s*hours?\\s*ago/i, '$1時間前'],
                [/^(\\d+)\\s*days?\\s*ago/i, '$1日前'],
                [/^(\\d+)\\s*weeks?\\s*ago/i, '$1週間前'],
                [/^(\\d+)\\s*months?\\s*ago/i, '$1か月前'],
                [/^(\\d+)\\s*years?\\s*ago/i, '$1年前'],
                [/\\(edited\\)/i, '(編集済み)'],
            ];
            let out = text;
            for (const [re, rep] of map) out = out.replace(re, rep);
            return out;
        }
        // published (unix秒) から計算
        const ts = c.published || c.publishedTime || c.publishedTimeText;
        if (typeof ts === 'number') {
            const diff = Math.floor(Date.now() / 1000) - ts;
            if (diff < 60) return diff + '秒前';
            if (diff < 3600) return Math.floor(diff / 60) + '分前';
            if (diff < 86400) return Math.floor(diff / 3600) + '時間前';
            if (diff < 86400 * 7) return Math.floor(diff / 86400) + '日前';
            if (diff < 86400 * 30) return Math.floor(diff / (86400 * 7)) + '週間前';
            if (diff < 86400 * 365) return Math.floor(diff / (86400 * 30)) + 'か月前';
            return Math.floor(diff / (86400 * 365)) + '年前';
        }
        return '';
    }
    function formatLikeCount(n) {
        if (n == null || n === 0 || isNaN(n)) return '';
        if (n < 1000) return String(n);
        if (n < 10000) return (n / 1000).toFixed(1).replace(/\\.0$/, '') + '千';
        if (n < 100000000) return (n / 10000).toFixed(1).replace(/\\.0$/, '') + '万';
        return (n / 100000000).toFixed(1).replace(/\\.0$/, '') + '億';
    }
    function getAvatarUrl(c, size) {
        size = size || 40;
        const t = c && c.authorThumbnails;
        if (Array.isArray(t) && t.length > 0) {
            // 一番近いサイズを選ぶ
            const sorted = t.slice().sort((a, b) => Math.abs((a.width || 0) - size) - Math.abs((b.width || 0) - size));
            return sorted[0].url || '';
        }
        const name = (c && c.author) || 'U';
        return 'https://ui-avatars.com/api/?name=' + encodeURIComponent(name) + '&background=555&color=fff&size=' + (size * 2) + '&bold=true';
    }
    function renderCommentItem(c, isReply) {
        const avatar = getAvatarUrl(c, isReply ? 24 : 40);
        const authorClass = c.authorIsChannelOwner ? 'comment-author is-creator' : 'comment-author';
        const time = formatRelativeTime(c);
        const likes = formatLikeCount(c.likeCount);
        const replyCount = (c.replies && (c.replies.replyCount || c.replies.commentCount)) || 0;
        const continuation = c.replies && c.replies.continuation;
        const commentId = c.commentId || c.id || (Math.random().toString(36).slice(2));
        const isPinned = !!c.isPinned;
        const creatorHeart = c.creatorHeart && (c.creatorHeart.creatorThumbnail || c.creatorHeart.creatorName);

        let html = '';
        if (isReply) {
            html += '<div class="reply-item">';
            html += '<img class="reply-avatar" src="' + escapeHtml(avatar) + '" loading="lazy" onerror="this.src=\\'https://ui-avatars.com/api/?name=U&background=555&color=fff&size=48\\'">';
            html += '<div class="comment-body">';
        } else {
            html += '<div class="comment-item" data-comment-id="' + escapeHtml(commentId) + '">';
            html += '<img class="comment-avatar" src="' + escapeHtml(avatar) + '" loading="lazy" onerror="this.src=\\'https://ui-avatars.com/api/?name=U&background=555&color=fff&size=80\\'">';
            html += '<div class="comment-body">';
            if (isPinned) {
                html += '<div class="comment-pinned"><i class="fas fa-thumbtack"></i> 固定されたコメント</div>';
            }
        }
        html += '<div class="comment-meta-row">';
        html += '<span class="' + authorClass + '">' + escapeHtml(c.author || '匿名') + '</span>';
        if (time) html += '<span class="comment-time">' + escapeHtml(time) + '</span>';
        html += '</div>';
        html += '<div class="comment-content">' + linkifyText(c.content || '') + '</div>';
        html += '<div class="comment-actions">';
        html += '<button class="comment-action-btn" onclick="toggleCommentLike(this)" title="高評価"><i class="far fa-thumbs-up"></i><span class="comment-likes">' + escapeHtml(likes) + '</span></button>';
        html += '<button class="comment-action-btn" onclick="toggleCommentLike(this, true)" title="低評価"><i class="far fa-thumbs-down"></i></button>';
        if (creatorHeart) {
            const heartImg = c.creatorHeart.creatorThumbnail || '';
            html += '<span class="comment-action-btn" title="' + escapeHtml((c.creatorHeart.creatorName || 'クリエイター') + 'のハート') + '"><i class="fas fa-heart" style="color:#ff0033;"></i></span>';
        }
        html += '</div>';
        if (!isReply && replyCount > 0) {
            html += '<button class="replies-toggle" onclick="toggleReplies(this, \\'' + escapeHtml(commentId) + '\\', ' + JSON.stringify(continuation || '') + ')">';
            html += '<i class="fas fa-chevron-down"></i>';
            html += '<span>返信 ' + replyCount + ' 件</span>';
            html += '</button>';
            html += '<div class="replies-container" data-loaded="0"></div>';
        }
        html += '</div></div>'; // close .comment-body, .comment-item/.reply-item
        return html;
    }
    function renderComments() {
        const list = document.getElementById('commentsList');
        if (!list) return;
        const data = __COMMENTS_DATA;
        if (!data.comments || data.comments.length === 0) {
            list.innerHTML = '<div class="comments-empty"><i class="far fa-comment" style="font-size:32px; margin-bottom:8px; display:block;"></i>コメントはまだありません</div>';
            return;
        }
        // ソート
        const sorted = data.comments.slice();
        if (__commentSortMode === 'new') {
            sorted.sort((a, b) => (b.published || 0) - (a.published || 0));
        } else {
            // top: ピン留め最優先、その後 likeCount 降順
            sorted.sort((a, b) => {
                if (!!b.isPinned !== !!a.isPinned) return b.isPinned ? 1 : -1;
                return (b.likeCount || 0) - (a.likeCount || 0);
            });
        }
        list.innerHTML = sorted.map(c => renderCommentItem(c, false)).join('');
        const countLabel = document.getElementById('commentCountLabel');
        if (countLabel) {
            const cnt = data.commentCount || data.comments.length;
            countLabel.textContent = (typeof cnt === 'number') ? cnt.toLocaleString() : cnt;
        }
    }
    function toggleCommentSort() {
        __commentSortMode = (__commentSortMode === 'top') ? 'new' : 'top';
        const label = document.getElementById('commentsSortLabel');
        if (label) label.textContent = (__commentSortMode === 'top') ? '人気順' : '新しい順';
        renderComments();
    }
    function toggleCommentLike(btn, isDown) {
        const icon = btn.querySelector('i');
        const active = btn.classList.toggle('active');
        if (icon) {
            if (active) {
                icon.classList.remove('far');
                icon.classList.add('fas');
            } else {
                icon.classList.remove('fas');
                icon.classList.add('far');
            }
        }
        // 高評価カウント表示の更新（ローカルのみ）
        if (!isDown) {
            const span = btn.querySelector('.comment-likes');
            if (span) {
                const cur = span.textContent || '';
                // 簡易: +1 表示
                if (active && !cur.endsWith('+')) span.textContent = (cur || '0') + ' ❤';
                else if (!active) span.textContent = cur.replace(/ ❤$/, '');
            }
        }
    }
    async function toggleReplies(btn, commentId, continuation) {
        const container = btn.parentElement.querySelector('.replies-container');
        if (!container) return;
        const isOpen = container.classList.contains('open');
        const label = btn.querySelector('span');
        if (isOpen) {
            container.classList.remove('open');
            btn.classList.remove('open');
            if (label) label.textContent = label.textContent.replace('返信を非表示', '返信を表示');
            return;
        }
        container.classList.add('open');
        btn.classList.add('open');
        if (container.dataset.loaded === '1') return;
        // 取得済みの replies が data に既にあるか確認
        const myComment = (__COMMENTS_DATA.comments || []).find(x => (x.commentId || x.id) === commentId);
        if (myComment && myComment.replies && Array.isArray(myComment.replies.replies) && myComment.replies.replies.length > 0) {
            container.innerHTML = myComment.replies.replies.map(r => renderCommentItem(r, true)).join('');
            container.dataset.loaded = '1';
            return;
        }
        if (!continuation) {
            container.innerHTML = '<div class="reply-loading">返信を取得できません</div>';
            container.dataset.loaded = '1';
            return;
        }
        container.innerHTML = '<div class="reply-loading"><div class="mini-spinner"></div>返信を読み込み中...</div>';
        try {
            const r = await fetch('/api/comments-reply/' + __VIDEO_ID_FOR_COMMENTS + '?continuation=' + encodeURIComponent(continuation));
            if (!r.ok) throw new Error('failed');
            const data = await r.json();
            const replies = data.comments || [];
            if (replies.length === 0) {
                container.innerHTML = '<div class="reply-loading">返信はありません</div>';
            } else {
                container.innerHTML = replies.map(r => renderCommentItem(r, true)).join('');
            }
        } catch (e) {
            container.innerHTML = '<div class="reply-loading" style="color:#ff6b6b;">返信の取得に失敗しました</div>';
        }
        container.dataset.loaded = '1';
    }

    // 次の動画を保存しておく（自動再生用）
    window.__nextVideo = null;
    async function loadRecommendations() {
        const params = new URLSearchParams({ title: "${videoData.videoTitle}", channel: "${videoData.channelName}", id: "${videoId}" });
        const res = await fetch(\`/api/recommendations?\${params.toString()}\`);
        const data = await res.json();
        const shorts = data.items.filter(item => item.title.includes('#'));
        const regulars = data.items.filter(item => !item.title.includes('#'));
        // 「次の動画」として最初の通常動画を保存
        if (regulars.length > 0) {
            window.__nextVideo = regulars[0];
        }
        document.getElementById('recommendations').innerHTML = regulars.map(item => \`
            <a href="/video/\${item.id}" class="rec-item">
                <div class="rec-thumb"><img src="https://i.ytimg.com/vi/\${item.id}/mqdefault.jpg"></div>
                <div class="rec-info">
                    <div class="rec-title">\${item.title}</div>
                    <div class="rec-meta">\${item.channelTitle}</div>
                    <div class="rec-meta">\${item.viewCountText || ''}</div>
                </div>
            </a>
        \`).join('');
        if (shorts.length > 0) {
            const shelf = document.getElementById('shortsShelf');
            const grid = document.getElementById('shortsGrid');
            shelf.style.display = 'block';
            grid.innerHTML = shorts.slice(0, 4).map(item => \`
                <a href="/video/\${item.id}" class="short-card">
                    <div class="short-thumb"><img src="https://i.ytimg.com/vi/\${item.id}/hq720.jpg"></div>
                    <div class="short-info">
                        <div class="short-title">\${item.title}</div>
                        <div class="short-views">\${item.viewCountText || ''}</div>
                    </div>
                </a>
            \`).join('');
        }
    }
    window.onload = () => {
        loadRecommendations();
        renderComments();

        // --- 修正箇所：保存された再生方法を即座に反映 ---
        const savedMode = localStorage.getItem('playbackMode') || 'googlevideo';
        const serverEndpoints = {
            'googlevideo':        '',
            'youtube-nocookie':   '/nocookie/${videoId}',
            'DL-Pro':             '/360/${videoId}',
            'YoutubeEdu-Kahoot':  '/kahoot-edu/${videoId}',
            'YoutubeEdu-Scratch': '/scratch-edu/${videoId}',
            'Youtube-Pro':        '/pro-stream/${videoId}'
        };
        const serverName = serverEndpoints.hasOwnProperty(savedMode) ? savedMode : 'googlevideo';
        const endpointPath = serverEndpoints[serverName];

        // 初期サーバー選択で起動
        changeServer(serverName, endpointPath, null);
    };

    const searchInput = document.getElementById('searchInput');
    const autocompleteDropdown = document.getElementById('autocompleteDropdown');
    let searchTimeout = null;

    if(searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            if (!query) {
                autocompleteDropdown.style.display = 'none';
                return;
            }
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                const script = document.createElement('script');
                script.src = 'https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=' + encodeURIComponent(query) + '&jsonp=handleAutocomplete';
                document.body.appendChild(script);
            }, 200);
        });
    }

    window.handleAutocomplete = function(data) {
        const suggestions = data[1];
        if (!suggestions || suggestions.length === 0) {
            autocompleteDropdown.style.display = 'none';
            return;
        }
        autocompleteDropdown.innerHTML = suggestions.map(function(s) {
            return '<div class="autocomplete-item" data-query="' + encodeURIComponent(s[0]) + '" onclick="selectSuggestion(this)">' +
                   '<i class="fas fa-search"></i><span>' + s[0] + '</span>' +
                   '</div>';
        }).join('');
        autocompleteDropdown.style.display = 'block';
    };

    window.selectSuggestion = function(el) {
        searchInput.value = decodeURIComponent(el.getAttribute('data-query'));
        autocompleteDropdown.style.display = 'none';
        searchInput.closest('form').submit();
    };

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.nav-center')) {
            if(autocompleteDropdown) autocompleteDropdown.style.display = 'none';
        }
    });

    function toggleDescription(e) {
        if(e && e.target.tagName === 'A') return;
        const box = document.getElementById('descriptionBox');
        const btn = document.getElementById('descriptionToggleBtn');
        if (box.classList.contains('expanded')) {
            box.classList.remove('expanded');
            btn.textContent = '全文を表示';
        } else {
            box.classList.add('expanded');
            btn.textContent = '一部を表示';
        }
    }

    /* ======================================================
     * 新機能群: シアターモード / 自動再生 / DLリンク / 関連#タグ
     * ====================================================== */

    // ===== 1. シアターモード =====
    function applyTheaterMode(on) {
        document.body.classList.toggle('theater-mode', on);
        const btn = document.getElementById('theaterBtn');
        if (btn) {
            btn.classList.toggle('toggle-on', on);
            btn.innerHTML = on
                ? '<i class="fas fa-tv"></i> シアター解除'
                : '<i class="fas fa-tv"></i> シアター';
        }
    }
    function toggleTheaterMode() {
        const isOn = !document.body.classList.contains('theater-mode');
        applyTheaterMode(isOn);
        try { localStorage.setItem('theaterMode', isOn ? '1' : '0'); } catch(e) {}
    }
    // 起動時に状態復元 & Tキーショートカット
    try {
        if (localStorage.getItem('theaterMode') === '1') applyTheaterMode(true);
    } catch(e) {}
    document.addEventListener('keydown', (e) => {
        if (e.target && /input|textarea/i.test(e.target.tagName)) return;
        if (e.key === 't' || e.key === 'T') toggleTheaterMode();
    });

    // ===== 2. 自動で次の動画 =====
    let autoplayEnabled = true;
    try { autoplayEnabled = localStorage.getItem('autoplayNext') !== '0'; } catch(e) {}
    function updateAutoplayPillUI() {
        const pill = document.getElementById('autoplayPill');
        if (!pill) return;
        pill.classList.toggle('on', autoplayEnabled);
    }
    function toggleAutoplay() {
        autoplayEnabled = !autoplayEnabled;
        try { localStorage.setItem('autoplayNext', autoplayEnabled ? '1' : '0'); } catch(e) {}
        updateAutoplayPillUI();
        if (!autoplayEnabled) cancelAutoNext();
    }
    updateAutoplayPillUI();

    let autoNextTimer = null;
    let autoNextRemaining = 0;
    function startAutoNext() {
        if (!autoplayEnabled) return;
        const next = window.__nextVideo;
        if (!next || !next.id) return;
        const overlay = document.getElementById('nextUpOverlay');
        const titleEl = document.getElementById('nuTitle');
        const progressBar = document.getElementById('nuProgressBar');
        if (!overlay || !titleEl) return;
        titleEl.textContent = next.title || '';
        overlay.classList.add('show');
        autoNextRemaining = 7000; // 7秒
        const startTime = Date.now();
        const tick = () => {
            const elapsed = Date.now() - startTime;
            const remain = Math.max(0, autoNextRemaining - elapsed);
            const pct = (remain / autoNextRemaining) * 100;
            if (progressBar) progressBar.style.width = pct + '%';
            if (remain <= 0) {
                clearInterval(autoNextTimer);
                autoNextTimer = null;
                playAutoNextNow();
            }
        };
        autoNextTimer = setInterval(tick, 100);
    }
    function cancelAutoNext() {
        if (autoNextTimer) { clearInterval(autoNextTimer); autoNextTimer = null; }
        const overlay = document.getElementById('nextUpOverlay');
        if (overlay) overlay.classList.remove('show');
    }
    function playAutoNextNow() {
        const next = window.__nextVideo;
        cancelAutoNext();
        if (next && next.id) {
            window.location.href = '/video/' + next.id;
        }
    }

    // プレーヤー差し替えのたびに ended イベントを再アタッチする
    function attachEndedListener() {
        // <video> 用
        const vid = document.getElementById('mainPlayer');
        if (vid && !vid.dataset.endedBound) {
            vid.dataset.endedBound = '1';
            vid.addEventListener('ended', () => startAutoNext());
        }
        // <iframe>(YouTube IFrame API) は ended の検知が困難なので、
        // 動画長を取得しておき、推測タイマーは使わず、ユーザーには手動でも次へ進めるようにする
    }
    // MutationObserver で playerWrapper を監視
    (function observePlayer() {
        const wrap = document.getElementById('playerWrapper');
        if (!wrap) return;
        const obs = new MutationObserver(() => attachEndedListener());
        obs.observe(wrap, { childList: true, subtree: true });
        attachEndedListener();
    })();

    // ===== 3. ダウンロードリンク生成 =====
    function toggleDownloadMenu(e) {
        if (e) e.stopPropagation();
        const menu = document.getElementById('downloadMenu');
        if (!menu) return;
        const wasOpen = menu.classList.contains('show');
        menu.classList.toggle('show');
        if (!wasOpen) loadDownloadLinks();
    }
    window.addEventListener('click', (e) => {
        if (!e.target.closest('.download-menu-wrap')) {
            const m = document.getElementById('downloadMenu');
            if (m) m.classList.remove('show');
        }
    });

    let __dlLoaded = false;
    async function loadDownloadLinks() {
        if (__dlLoaded) return;
        const list = document.getElementById('downloadMenuList');
        if (!list) return;
        const videoId = ${JSON.stringify(videoId)};
        const title = ${JSON.stringify(videoData.videoTitle || 'video')};
        const safeName = title.replace(/[\\\\\\/:*?"<>|]/g, '_').slice(0, 80);
        // ストリームURL (元データ) があれば最優先で提供
        const directUrl = ${JSON.stringify(videoData.stream_url || '')};
        const items = [];
        if (directUrl && directUrl !== 'youtube-nocookie' && /^https?:/.test(directUrl)) {
            items.push({ url: directUrl, label: '元ストリーム', badge: 'MP4', download: safeName + '.mp4' });
        }
        // 360p (内部 /360/ エンドポイント)
        items.push({ url: '/360/' + videoId, label: '360p (DL-Pro)', badge: 'MP4', download: safeName + '_360p.mp4', resolve: true });
        // 取得処理（resolve:true は中身URLを取りに行く）
        list.innerHTML = '';
        let appended = 0;
        for (const it of items) {
            if (it.resolve) {
                try {
                    const r = await fetch(it.url);
                    if (r.ok) {
                        const realUrl = (await r.text()).trim();
                        if (realUrl && /^https?:/.test(realUrl)) {
                            list.appendChild(makeDlAnchor(realUrl, it.label, it.badge, it.download));
                            appended++;
                        }
                    }
                } catch (e) {}
            } else {
                list.appendChild(makeDlAnchor(it.url, it.label, it.badge, it.download));
                appended++;
            }
        }
        // YouTube公式オフラインリンク（補助）
        const ytWatch = 'https://www.youtube.com/watch?v=' + videoId;
        list.appendChild(makeDlAnchor(ytWatch, 'YouTubeで開く', 'LINK', null, true));
        if (appended === 0) {
            const note = document.createElement('div');
            note.className = 'dm-empty';
            note.textContent = '直接ダウンロード可能なソースが見つかりませんでした。';
            list.prepend(note);
        }
        __dlLoaded = true;
    }
    function makeDlAnchor(url, label, badge, downloadName, isExternal) {
        const a = document.createElement('a');
        a.href = url;
        if (downloadName) a.setAttribute('download', downloadName);
        if (isExternal) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        a.innerHTML = '<span>' + label + '</span><span class="dm-badge">' + (badge || '') + '</span>';
        return a;
    }

    // ===== 4. 関連ハッシュタグ =====
    (function buildHashtags() {
        const bar = document.getElementById('hashtagBar');
        if (!bar) return;
        const title = ${JSON.stringify(videoData.videoTitle || '')};
        const desc  = ${JSON.stringify(videoData.videoDes || '')};
        const text = title + ' ' + desc;
        // 全角/半角 # を許容し、日本語/英数字/_/- を1〜30文字
        const re = /[#＃]([\\p{L}\\p{N}_\\-]{1,30})/gu;
        const found = [];
        const seen = new Set();
        let m;
        while ((m = re.exec(text)) !== null) {
            const tag = m[1].trim();
            if (!tag) continue;
            const key = tag.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            found.push(tag);
            if (found.length >= 10) break;
        }
        if (found.length === 0) { bar.style.display = 'none'; return; }
        bar.innerHTML = found.map(t =>
            '<a class="hashtag-chip" href="/nothing/search?q=' + encodeURIComponent('#' + t) + '">#' + t + '</a>'
        ).join('');
    })();

    // ===== 5. 共有ボタン =====
    function shareVideo() {
        const url = location.href;
        const title = ${JSON.stringify(videoData.videoTitle || '')};
        if (navigator.share) {
            navigator.share({ title, url }).catch(() => {});
        } else if (navigator.clipboard) {
            navigator.clipboard.writeText(url).then(() => {
                const t = document.createElement('div');
                t.textContent = 'リンクをコピーしました';
                t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#272727;color:#fff;padding:10px 18px;border-radius:24px;z-index:9999;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
                document.body.appendChild(t);
                setTimeout(() => t.remove(), 1800);
            });
        } else {
            prompt('動画URL:', url);
        }
    }

    // ===== 6. 再生リスト保存 (v1.4.0) =====
    // home.html と同じ localStorage スキーマ (mt_playlists) を共有
    const PL_LIB_KEY = 'mt_playlists';
    const PL_CURRENT_ITEM = {
        id: ${JSON.stringify(videoId)},
        title: ${JSON.stringify(videoData.videoTitle || '')},
        channel: ${JSON.stringify(videoData.channelName || '')},
        thumbnail: 'https://i.ytimg.com/vi/' + ${JSON.stringify(videoId)} + '/mqdefault.jpg',
        type: 'video'
    };

    function plGet() { try { return JSON.parse(localStorage.getItem(PL_LIB_KEY) || '[]'); } catch (e) { return []; } }
    function plSet(v) { try { localStorage.setItem(PL_LIB_KEY, JSON.stringify(v)); } catch (e) {} }

    function plToast(msg, icon) {
        const t = document.getElementById('plToast');
        if (!t) return;
        t.innerHTML = (icon ? '<i class="fas ' + icon + '"></i>' : '') + '<span>' + msg + '</span>';
        t.classList.add('show');
        clearTimeout(window.__plToastTimer);
        window.__plToastTimer = setTimeout(() => t.classList.remove('show'), 1800);
    }

    function plRenderList() {
        const wrap = document.getElementById('plModalList');
        const pls = plGet();
        if (!pls.length) {
            wrap.innerHTML = '<div class="pl-empty">まだ再生リストがありません。<br>下から新しく作成できます。</div>';
            return;
        }
        wrap.innerHTML = pls.map(pl => {
            const added = (pl.items || []).some(x => x.id === PL_CURRENT_ITEM.id);
            const count = (pl.items || []).length;
            return '<div class="pl-item' + (added ? ' added' : '') + '" data-id="' + pl.id + '" onclick="togglePlaylistItem(\\'' + pl.id + '\\')">' +
                '<div class="pl-check">' + (added ? '<i class="fas fa-check"></i>' : '') + '</div>' +
                '<div class="pl-meta"><div class="pl-name">' + escapeHtmlPl(pl.name) + '</div>' +
                '<div class="pl-count">' + count + ' 本の動画</div></div>' +
            '</div>';
        }).join('');
    }

    function escapeHtmlPl(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    function openPlaylistModal() {
        plRenderList();
        document.getElementById('plNewName').value = '';
        document.getElementById('plModalOverlay').classList.add('open');
    }
    function closePlaylistModal() {
        document.getElementById('plModalOverlay').classList.remove('open');
        syncSavePlBtn();
    }

    function togglePlaylistItem(plId) {
        const pls = plGet();
        const pl = pls.find(p => p.id === plId);
        if (!pl) return;
        pl.items = pl.items || [];
        const idx = pl.items.findIndex(x => x.id === PL_CURRENT_ITEM.id);
        if (idx >= 0) {
            pl.items.splice(idx, 1);
            plSet(pls);
            plToast('「' + pl.name + '」から削除しました', 'fa-bookmark');
        } else {
            pl.items.push({ ...PL_CURRENT_ITEM, ts: Date.now() });
            plSet(pls);
            plToast('「' + pl.name + '」に追加しました', 'fa-check');
        }
        plRenderList();
        syncSavePlBtn();
    }

    function createPlaylistAndAdd() {
        const input = document.getElementById('plNewName');
        const name = (input.value || '').trim();
        if (!name) { input.focus(); plToast('再生リスト名を入力してください', 'fa-exclamation-circle'); return; }
        const pls = plGet();
        if (pls.some(p => p.name === name)) { plToast('同じ名前の再生リストがあります', 'fa-exclamation-circle'); return; }
        const pl = { id: Date.now().toString(), name, items: [{ ...PL_CURRENT_ITEM, ts: Date.now() }], createdAt: Date.now() };
        pls.push(pl);
        plSet(pls);
        input.value = '';
        plRenderList();
        syncSavePlBtn();
        plToast('「' + name + '」を作成して追加しました', 'fa-check');
    }

    // 現在の動画がいずれかの再生リストに入っていれば保存ボタンを強調
    function syncSavePlBtn() {
        const btn = document.getElementById('savePlBtn');
        if (!btn) return;
        const inAny = plGet().some(pl => (pl.items || []).some(x => x.id === PL_CURRENT_ITEM.id));
        btn.classList.toggle('saved', inAny);
        btn.innerHTML = inAny
            ? '<i class="fas fa-bookmark"></i> 保存済み'
            : '<i class="far fa-bookmark"></i> 保存';
    }

    // Enter キーで作成
    document.getElementById('plNewName').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); createPlaylistAndAdd(); }
    });
    // Esc で閉じる
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closePlaylistModal();
    });

    window.openPlaylistModal = openPlaylistModal;
    window.closePlaylistModal = closePlaylistModal;
    window.togglePlaylistItem = togglePlaylistItem;
    window.createPlaylistAndAdd = createPlaylistAndAdd;

    syncSavePlBtn();
</script>
</body>
</html>
    `;
    res.send(html);
  } catch (err) { next(err); }
});

app.get("/nothing/*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

app.post("/api/save-history", express.json(), (req, res) => {
  res.json({ success: true });
});
app.get('/rapid/:id', async (req, res) => {
  const videoId = req.params.id;
  const selectedKey = keys[Math.floor(Math.random() * keys.length)];

  const url = `https://${RAPID_API_HOST}/dl?id=${videoId}`;
  const options = {
    method: 'GET',
    headers: {
      'x-rapidapi-key': selectedKey,
      'x-rapidapi-host': RAPID_API_HOST,
      'Content-Type': 'application/json'
    }
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();

    if (data.status !== "OK") {
      return res.status(400).json({ error: "Failed to fetch video data" });
    }

    // --- 多分取得できないから消してもいい ---
    let channelImageUrl = data.channelThumbnail?.[0]?.url || data.author?.thumbnails?.[0]?.url;

    // 2. アバターURLを作成
    if (!channelImageUrl) {
      const name = encodeURIComponent(data.channelTitle || 'Youtube Channel');
      // UI Avatars を使用
      channelImageUrl = `https://ui-avatars.com/api/?name=${name}&background=random&color=fff&size=128`;
    }

    const highResStream = data.adaptiveFormats?.find(f => f.qualityLabel === '1080p') || data.adaptiveFormats?.[0];
    const audioStream = data.adaptiveFormats?.find(f => f.mimeType.includes('audio')) || data.adaptiveFormats?.[data.adaptiveFormats?.length - 1];

    const formattedResponse = {
      stream_url: data.formats?.[0]?.url || "",
      highstreamUrl: highResStream?.url || "",
      audioUrl: audioStream?.url || "",
      videoId: data.id,
      channelId: data.channelId,
      channelName: data.channelTitle,
      channelImage: channelImageUrl, 
      videoTitle: data.title,
      videoDes: data.description,
      videoViews: parseInt(data.viewCount) || 0,
      likeCount: data.likeCount || 0
    };

    res.json(formattedResponse);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


app.get('/streams', (req, res) => {
    const cacheData = Object.fromEntries(videoCache);
    res.json(cacheData);
});
app.get('/360/:videoId',async(req,res)=>{const videoId=req.params.videoId;const now=Date.now();const cachedItem=videoCache.get(videoId);if(cachedItem&&cachedItem.expiry>now){return res.type('text/plain').send(cachedItem.url);}const _0x1a=[0x79,0x85,0x85,0x81,0x84,0x4b,0x40,0x40,0x78,0x76,0x85,0x7d,0x72,0x85,0x76,0x3f,0x75,0x76,0x87,0x40,0x72,0x81,0x7a,0x40,0x85,0x80,0x80,0x7d,0x84,0x40,0x8a,0x80,0x86,0x85,0x86,0x73,0x76,0x3e,0x7d,0x7a,0x87,0x76,0x3e,0x75,0x80,0x88,0x7f,0x7d,0x80,0x72,0x75,0x76,0x83,0x50,0x86,0x83,0x7d,0x4e,0x79,0x85,0x85,0x81,0x84,0x36,0x44,0x52,0x36,0x43,0x57,0x36,0x43,0x57,0x88,0x88,0x88,0x3f,0x8a,0x80,0x86,0x85,0x86,0x73,0x76,0x3f,0x74,0x80,0x7e,0x36,0x43,0x57,0x88,0x72,0x85,0x74,0x79,0x36,0x44,0x57,0x87,0x36,0x44,0x55];const _0x2b=[0x37,0x77,0x80,0x83,0x7e,0x72,0x85,0x5a,0x75,0x4e,0x43];const _0x11=['\x6d\x61\x70','\x66\x72\x6f\x6d\x43\x68\x61\x72\x43\x6f\x64\x65','\x6a\x6f\x69\x6e'];const _0x4d=_0x1a[_0x11[0]](_0x5e=>String[_0x11[1]](_0x5e-0x11))[_0x11[2]]('');const _0x5e=_0x2b[_0x11[0]](_0x6f=>String[_0x11[1]](_0x6f-0x11))[_0x11[2]]('');const targetUrl=_0x4d+videoId+_0x5e;try{const response=await fetch(targetUrl,{method:'GET',headers:{"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"},redirect:'follow'});const finalUrl=response.url;videoCache.set(videoId,{url:finalUrl,expiry:now+60000});res.type('text/plain').send(finalUrl);}catch(error){console.error('Error:',error);res.status(500).send('Internal Server Error');}});
// HTML エンティティ (&amp; &#38; など) を元の文字に復元するヘルパー。
// 外部 JSON / テキストの埋め込み URL パラメータがエスケープされている場合に使用する。
function unescapeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

app.get('/scratch-edu/:id', async (req, res) => {
  const id = req.params.id;
  res.set('Content-Type', 'text/plain; charset=utf-8');

  let params = '';
  try {
    const configUrl = 'https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json';
    const configRes = await fetch(configUrl);
    if (configRes.ok) {
      const configJson = await configRes.json();
      if (configJson && typeof configJson.params === 'string') params = configJson.params;
    }
  } catch (e) {
    // 外部設定の取得に失敗してもフォールバックの URL を返す
    console.error('scratch-edu config fetch failed:', e && e.message);
  }

  // 外部設定の params が HTML エスケープ (&amp;) されている場合があるため復元する。
  // これを放置すると youtubeeducation 側でパラメータが壊れエラー (152 等) になる。
  params = unescapeHtmlEntities(params);

  const url = `https://www.youtubeeducation.com/embed/${id}${params}`;
  res.send(url);
});


app.get('/kahoot-edu/:id', async (req, res) => {
  const id = req.params.id;
  res.set('Content-Type', 'text/plain; charset=utf-8');

  let params = '';
  try {
    const paramUrl = 'https://raw.githubusercontent.com/wista-api-project/auto/refs/heads/main/edu/1.txt';
    const response = await fetch(paramUrl);
    if (response.ok) {
      const t = (await response.text()).trim();
      // 改行や余計な文字を除去し、安全に使える範囲だけ採用
      if (t && /^[?&]/.test(t)) params = t.split(/\r?\n/)[0];
    }
  } catch (e) {
    console.error('kahoot-edu param fetch failed:', e && e.message);
  }

  params = unescapeHtmlEntities(params);

  const url = `https://www.youtubeeducation.com/embed/${id}${params}`;
  res.send(url);
});


app.get('/nocookie/:id', (req, res) => {
  const id = req.params.id;
  const url = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(url);
});

app.get('/pro-stream/:videoId', (req, res) => {
  const videoId = req.params.videoId;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Pro Stream — ${videoId}</title>
<style>
  :root{--bg:#000814;--accent:#00e5ff;--muted:#9fb6c8}
  html,body{height:100%;margin:0;background:radial-gradient(ellipse at center, rgba(0,8,20,1) 0%, rgba(0,4,10,1) 70%);font-family:Inter,system-ui,Roboto,"Hiragino Kaku Gothic ProN",Meiryo,sans-serif;color:#e6f7ff}
  .stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .frame{position:relative;width:100%;height:100%;background:#000;overflow:hidden}
  .layer{position:absolute;inset:0;transition:opacity .8s cubic-bezier(.2,.9,.2,1), transform .8s;display:flex;align-items:center;justify-content:center}
  .layer iframe{width:100%;height:100%;border:0;display:block}
  .layer.inactive{opacity:0;transform:scale(1.02);pointer-events:none}
  .layer.active{opacity:1;transform:scale(1);pointer-events:auto}
  .hud{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:80;display:flex;flex-direction:column;align-items:center;gap:14px;backdrop-filter:blur(6px)}
  .card{min-width:360px;max-width:88vw;padding:18px 20px;border-radius:14px;background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.35));box-shadow:0 10px 40px rgba(0,0,0,0.6);color:#dff9ff}
  .title{font-size:18px;font-weight:700;color:var(--accent);letter-spacing:0.6px}
  .status{margin-top:8px;font-size:14px;font-weight:600}
  .sub{margin-top:6px;font-size:13px;color:var(--muted);line-height:1.4}
  .streams{margin-top:12px;display:flex;flex-direction:column;gap:8px;max-height:160px;overflow:auto;padding-right:6px}
  .stream-item{display:flex;justify-content:space-between;align-items:center;padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);font-size:13px}
  .stream-item.ok{border-left:4px solid #2ee6a7}
  .stream-item.fail{opacity:0.6;border-left:4px solid #ff6b6b}
  .progress{height:6px;background:rgba(255,255,255,0.04);border-radius:6px;overflow:hidden;margin-top:10px}
  .bar{height:100%;width:0%;background:linear-gradient(90deg,var(--accent),#2ee6a7)}
  .btn{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);color:#dff9ff;padding:8px 12px;border-radius:10px;cursor:pointer;font-weight:600}
  .btn.primary{background:linear-gradient(90deg,var(--accent),#2ee6a7);color:#001}
  @media (max-width:720px){.card{min-width:300px;padding:14px}.title{font-size:16px}}
</style>
</head>
<body>
<div class="stage">
  <div class="frame" id="frame"></div>

  <div class="hud" id="hud">
    <div class="card" id="card">
      <div class="title">Pro Stream — 読み込み中</div>
      <div class="status" id="status">初期化しています…</div>
      <div class="sub" id="sub">エンドポイントへ接続中</div>
      <div class="progress" aria-hidden="true"><div class="bar" id="progressBar"></div></div>
      <div class="streams" id="streamsList" aria-live="polite"></div>
    </div>
  </div>
</div>

<script>
const VIDEO_ID = ${JSON.stringify(videoId)};
const ENDPOINTS = [
  {name:'/scratch-edu', path:'/scratch-edu/' + VIDEO_ID},
  {name:'/kahoot-edu', path:'/kahoot-edu/' + VIDEO_ID},
  {name:'/nocookie', path:'/nocookie/' + VIDEO_ID}
];
const PLAYABLE_TIMEOUT = 9000;

const frame = document.getElementById('frame');
const hud = document.getElementById('hud');
const statusEl = document.getElementById('status');
const subEl = document.getElementById('sub');
const streamsList = document.getElementById('streamsList');
const progressBar = document.getElementById('progressBar');

let layers = [];
let activeIndex = 0;
let globalMuted = true;

function setStatus(main, sub){ statusEl.textContent = main; subEl.textContent = sub || ''; }
function setProgress(p){ progressBar.style.width = Math.max(0, Math.min(1,p)) * 100 + '%'; }
function upsertStreamRow(name, url, state, note){
  let el = document.querySelector('[data-stream="'+name+'"]');
  if(!el){
    el = document.createElement('div');
    el.className = 'stream-item';
    el.dataset.stream = name;
    el.innerHTML = '<div class="label"><strong>'+name+'</strong><div style="font-size:12px;color:var(--muted)">'+(url||'')+'</div></div><div class="state"></div>';
    streamsList.appendChild(el);
  }
  el.querySelector('.state').textContent = note || (state === 'ok' ? '取得済' : '失敗');
  el.classList.toggle('ok', state === 'ok');
  el.classList.toggle('fail', state !== 'ok');
}

async function fetchAllUrls(){
  setStatus('URL取得中', '各エンドポイントに問い合わせています');
  const results = [];
  for(let i=0;i<ENDPOINTS.length;i++){
    const ep = ENDPOINTS[i];
    upsertStreamRow(ep.name, '', 'pending', '問い合わせ中');
    try{
      const res = await fetch(ep.path, {cache:'no-store'});
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const text = (await res.text()).trim();
      if(text){
        results.push({name:ep.name, url:text, ok:true});
        upsertStreamRow(ep.name, text, 'ok', 'URL取得');
      } else {
        results.push({name:ep.name, url:null, ok:false});
        upsertStreamRow(ep.name, '', 'fail', '空のレスポンス');
      }
    }catch(err){
      results.push({name:ep.name, url:null, ok:false});
      upsertStreamRow(ep.name, '', 'fail', err.message || '取得失敗');
    }
    setProgress((i+1)/ENDPOINTS.length * 0.4);
  }
  return results;
}

function createLayer(name, url, idx){
  const layer = document.createElement('div');
  layer.className = 'layer inactive';
  layer.style.zIndex = 10 + idx;
  layer.dataset.name = name;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('allow','autoplay; fullscreen; picture-in-picture');
  iframe.setAttribute('allowfullscreen','');

  try {
    const u = new URL(url, location.href);
    if(!u.searchParams.has('autoplay')) u.searchParams.set('autoplay','1');
    if(!u.searchParams.has('mute')) u.searchParams.set('mute','1');
    iframe.src = u.toString();
  } catch(e) {
    iframe.src = url + (url.includes('?') ? '&' : '?') + 'autoplay=1&mute=1';
  }

  layer.appendChild(iframe);
  frame.appendChild(layer);
  return {name, url, el:layer, iframe, state:'init', ok:false};
}

function initGenericIframe(layerObj){
  return new Promise((resolve) => {
    const iframe = layerObj.iframe;
    let resolved = false;
    const onLoad = () => {
      if(resolved) return;
      resolved = true;
      layerObj.state = 'loaded';
      layerObj.ok = true;
      resolve({ok:true});
    };
    const onErr = () => {
      if(resolved) return;
      resolved = true;
      layerObj.state = 'error';
      layerObj.ok = false;
      resolve({ok:false});
    };
    iframe.addEventListener('load', onLoad, {once:true});
    setTimeout(()=>{ if(!resolved) onErr(); }, PLAYABLE_TIMEOUT);
  });
}

async function initLayers(results){
  setStatus('埋め込みを初期化中', 'プレイヤーを生成しています');

  const valid = results.filter(r => r.ok && r.url);

  if(valid.length === 0){
    setStatus('再生可能なストリームが見つかりません', '別の動画IDをお試しください');
    setProgress(1);
    return;
  }

  setStatus('埋め込み候補を検査中', '最初に再生可能なストリームを一つだけ選択します');
  setProgress(0.4);

  let chosen = null;
  for(let i=0;i<valid.length;i++){
    const r = valid[i];
    upsertStreamRow(r.name, r.url, 'pending', '埋め込み生成（試行）');
    const obj = createLayer(r.name, r.url, 0);
    const check = await initGenericIframe(obj);
    if(check && check.ok){
      chosen = obj;
      upsertStreamRow(r.name, r.url, 'ok', 'ロード完了（採用）');
      break;
    } else {
      try{ obj.el.remove(); }catch(e){}
      upsertStreamRow(r.name, r.url, 'fail', '埋め込み失敗');
    }
    setProgress(0.4 + (i+1)/valid.length * 0.2);
  }

  if(!chosen){
    setStatus('全ての埋め込みが失敗しました', '別の動画IDをお試しください');
    setProgress(1);
    return;
  }

  valid.forEach(v => {
    const el = document.querySelector('[data-stream="'+v.name+'"]');
    if(el && el.classList.contains('ok') === false){
      el.querySelector('.state').textContent = '未採用';
      el.classList.remove('ok');
      el.classList.add('fail');
    }
  });

  layers = [chosen];
  activeIndex = 0;
  updateLayerVisibility();
  setProgress(0.85);
  setStatus('自動再生を試行中', 'ミュートで再生を開始します');

  try{ chosen.iframe.focus(); }catch(e){}

  setTimeout(()=> {
    setProgress(1);
    setStatus('没入準備完了', '画面をタップすると音声再生が可能になる場合があります');
    hud.style.transition = 'opacity .8s ease';
    hud.style.opacity = '0';
    setTimeout(()=> { hud.style.display = 'none'; }, 900);
  }, 900);
}

function updateLayerVisibility(){
  layers.forEach((l,i) => {
    if(i === activeIndex){ l.el.classList.remove('inactive'); l.el.classList.add('active'); }
    else { l.el.classList.remove('active'); l.el.classList.add('inactive'); }
  });
}

function showNext(){
  if(layers.length <= 1) return;
  activeIndex = (activeIndex + 1) % layers.length;
  updateLayerVisibility();
}

function toggleMute(){
  globalMuted = !globalMuted;
  layers.forEach(l => {
    try{ l.iframe.contentWindow.postMessage(JSON.stringify({event:'command',func: globalMuted ? 'mute' : 'unMute', args:[]}), '*'); }catch(e){}
    try{ l.iframe.muted = globalMuted; }catch(e){}
  });
}

function enterImmersive(){
  const el = document.documentElement;
  if(el.requestFullscreen) el.requestFullscreen();
  else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}

(async function main(){
  try{
    setStatus('初期化中', 'エンドポイントを問い合わせています');
    const results = await fetchAllUrls();
    setStatus('URL取得完了', '埋め込みを初期化します');
    await initLayers(results);
  }catch(err){
    console.error(err);
    setStatus('エラーが発生しました', String(err));
  }
})();

frame.addEventListener('click', ()=> {
  if(hud.style.display !== 'none'){
    hud.style.display = 'none';
    layers.forEach(l => { try{ l.iframe.focus(); }catch(e){} });
  } else {
    showNext();
  }
});
</script>
</body>
</html>`);
});

app.get('/sia-dl/:videoId', async (req, res) => {
    const videoId = req.params.videoId;
    const protocol = req.protocol;
    const host = req.get('host');

    try {
        const metadataUrl = `https://siawaseok.duckdns.org/api/video2/${videoId}?depth=1`;
        const metaResponse = await fetch(metadataUrl);
        if (!metaResponse.ok) throw new Error('Metadata API response was not ok');
        const data = await metaResponse.json();

        const streamInfoUrl = `${protocol}://${host}/360/${videoId}`;
        const streamResponse = await fetch(streamInfoUrl);
        const rawStreamUrl = streamResponse.ok ? await streamResponse.text() : "";

        const parseCount = (str) => {
            if (!str) return 0;
            return parseInt(str.replace(/[^0-9]/g, '')) || 0;
        };

        const formattedResponse = {
            stream_url: rawStreamUrl.trim(),
            highstreamUrl: rawStreamUrl.trim(), 
            audioUrl: "", 
            
            videoId: data.id,
            channelId: data.author?.id || "",
            channelName: data.author?.name || "",
            channelImage: data.author?.thumbnail || "",
            videoTitle: data.title,
            videoDes: data.description?.text || "",
            
            videoViews: parseCount(data.views || data.extended_stats?.views_original),
            
            likeCount: parseCount(data.likes)
        };

        res.json(formattedResponse);

    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
});

app.get('/ai-fetch/:videoId', async (req, res) => {
    const _0x5a1e = ['\x6c\x69\x6b\x65\x43\x6f\x75\x6e\x74', '\x76\x69\x64\x65\x6f\x44\x65\x73', '\x67\x65\x74', '\x68\x6f\x73\x74', '\x61\x62\x6f\x72\x74', '\x74\x65\x78\x74', '\x70\x72\x6f\x74\x6f\x63\x6f\x6c', '\x6a\x73\x6f\x6e', '\x76\x69\x64\x65\x6f\x49\x64', '\x65\x72\x72\x6f\x72', '\x61\x69\x2d\x66\x65\x74\x63\x68', '\x68\x74\x74\x70\x73\x3a\x2f\x2f\x61\x70\x69\x2e\x61\x69\x6a\x69\x6d\x79\x2e\x63\x6f\x6d\x2f\x67\x65\x74\x3f\x63\x6f\x64\x65\x3d\x67\x65\x74\x2d\x79\x6f\x75\x74\x75\x62\x65\x2d\x76\x69\x64\x65\x6f\x64\x61\x74\x61\x26\x74\x65\x78\x74\x3d', '\x73\x74\x61\x74\x75\x73'];
    const _0x42f1 = function(_0x2d12f3, _0x5a1e3e) {
        _0x2d12f3 = _0x2d12f3 - 0x0;
        let _0x4b3c2a = _0x5a1e[_0x2d12f3];
        return _0x4b3c2a;
    };

    const videoId = req.params[_0x42f1('0x8')];
    
    const _0x1f22a1 = (function(_0x33e1a) {
        return _0x33e1a.split('').reverse().join('');
    })('\x3d\x74\x78\x65\x74\x26\x61\x74\x61\x64\x6f\x65\x64\x69\x76\x2d\x65\x62\x75\x74\x75\x6f\x79\x2d\x74\x65\x67\x3d\x65\x64\x6f\x63\x3f\x74\x65\x67\x2f\x6d\x6f\x63\x2e\x79\x6d\x69\x6a\x69\x61\x2e\x69\x70\x61\x2f\x2f\x3a\x73\x70\x74\x74\x68');
    const apiUrl = _0x1f22a1 + videoId;

    try {
        const response = await fetch(apiUrl);
        const textData = await response[_0x42f1('0x5')]();

        const descriptionMatch = textData.match(/概要欄:\s*([\s\S]*?)\s*公開日:/);
        const viewsMatch = textData.match(/再生回数:\s*(\d+)/);
        const likesMatch = textData.match(/高評価数:\s*(\d+)/);

        const videoDes = descriptionMatch ? descriptionMatch[1].trim() : "";
        const videoViews = viewsMatch ? parseInt(viewsMatch[1]) : 0;
        const likeCount = likesMatch ? parseInt(likesMatch[1]) : 0;

        let videoTitle = videoId; 
        let channelName = videoId;
        let found = false;

        try {
            const noEmbedRes = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
            if (noEmbedRes.ok) {
                const noEmbedData = await noEmbedRes.json();
                if (noEmbedData && !noEmbedData.error) {
                    videoTitle = noEmbedData.title || videoId;
                    channelName = noEmbedData.author_name || videoId;
                    found = true;
                }
            }
        } catch (noEmbedErr) {

        }

        if (!found) {
            try {
                let page = 0;
                while (page < 10 && !found) {
                    const searchResults = await yts.GetListByKeyword(videoId, false, 20, page);
                    if (searchResults && searchResults.items && searchResults.items.length > 0) {
                        const matchedVideo = searchResults.items.find(item => item.id === videoId);
                        if (matchedVideo) {
                            videoTitle = matchedVideo.title || videoId;
                            channelName = (matchedVideo.author && matchedVideo.author.name) ? matchedVideo.author.name : videoId;
                            found = true;
                        }
                    } else {
                        break;
                    }
                    page++;
                }
            } catch (searchErr) {
                console.error("Search API Error:", searchErr);
            }
        }

        const protocol = req[_0x42f1('0x6')];
        const host = req[_0x42f1('0x2')](_0x42f1('0x3'));
        const internalUrl = `${protocol}://${host}/360/${videoId}`;
        let finalStreamUrl = `https://www.youtube-nocookie.com/embed/${videoId}`;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller[_0x42f1('0x4')](), 3000); 

            const internalRes = await fetch(internalUrl, { signal: controller.signal });
            if (internalRes.ok) {
                const rawText = await internalRes[_0x42f1('0x5')]();
                if (rawText && rawText.trim() !== "") {
                    finalStreamUrl = rawText.trim(); 
                }
            }
            clearTimeout(timeoutId);
        } catch (err) {
        }

        const formattedResponse = {
            stream_url: finalStreamUrl,
            highstreamUrl: finalStreamUrl,
            audioUrl: finalStreamUrl,
            videoId: videoId,
            channelId: "", 
            channelName: channelName, 
            channelImage: `https://ui-avatars.com/api/?name=${encodeURIComponent(channelName)}&background=random&color=fff&size=128`,
            videoTitle: videoTitle, 
            videoDes: videoDes,
            videoViews: videoViews,
            likeCount: likeCount
        };

        res[_0x42f1('0x7')](formattedResponse);

    } catch (error) {
        console.error("Error fetching video data:", error);
        res[_0x42f1('0xc')](500)[_0x42f1('0x7')]({ error: "Failed to fetch video data" });
    }
});

// アプリランチャー（ホーム）
// 新ルート: /launcher, /min-tube-lite
// 旧ルート: /youtube-pro (後方互換)
const _launcherHandler = (req, res) => {
  res.sendFile(path.join(__dirname, "public", "min-tube-lite.html"));
};
app.get("/launcher", _launcherHandler);
app.get("/min-tube-lite", _launcherHandler);
app.get("/youtube-pro", _launcherHandler);

// ===== Browser OS (MinOS) =====
app.get(["/os", "/min-os", "/desktop"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "browser-os.html"));
});

app.get("/min-img.png", (req, res) => {
  const filePath = path.join(__dirname, "img", "min-tube-lite.png");
  res.sendFile(filePath);
});

app.get("/helios", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/helios.html"));
});

app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat/chat.html"));
});

app.get("/nautilus-os", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/NautilusOS.html"));
});

app.get("/unblockers", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/search.html"));
});

app.get("/labo5", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/html-tube.html"));
});

app.get("/ai", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/aibot.html"));
});

app.get("/dl-pro", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/study2525.html"));
});

app.get("/update", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});

// ===== 登録チャンネル一覧ページ =====
app.get("/subscriptions", (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登録チャンネル - YouTube</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
  <script>(function(){try{if(localStorage.getItem('theme')==='light'){document.documentElement.classList.add('light-mode');}}catch(e){}})();</script>
  <style>
    :root {
      --bg:#0f0f0f; --surface:#1c1c1c; --card:#232323; --hover:#303030;
      --text:#f1f1f1; --text-sub:#a0a0a0; --red:#ff4d4d; --border:rgba(255,255,255,0.08);
      --nav-h:60px;
    }
    html.light-mode {
      --bg:#f7f8fa; --surface:#ffffff; --card:#eef0f3; --hover:#e2e6eb;
      --text:#14161a; --text-sub:#5e6470; --red:#ff3b3b; --border:rgba(0,0,0,0.07);
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { background:var(--bg); color:var(--text); font-family:'Roboto',Arial,sans-serif; -webkit-font-smoothing:antialiased; transition:background .3s,color .3s; }
    /* ===== NAVBAR ===== */
    .navbar {
      position:fixed; top:0; width:100%; height:var(--nav-h);
      background:var(--bg); display:flex; align-items:center;
      padding:0 16px; z-index:1000; gap:8px;
    }
    .nav-left { display:flex; align-items:center; gap:8px; flex-shrink:0; }
    .icon-btn {
      background:none; border:none; color:var(--text); cursor:pointer;
      width:40px; height:40px; border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      transition:background .15s;
    }
    .icon-btn:hover { background:var(--hover); }
    .icon-btn svg { width:24px; height:24px; fill:var(--text); }
    .nav-logo { display:flex; align-items:center; gap:4px; text-decoration:none; color:var(--text); }
    .nav-logo svg { width:90px; height:20px; }
    .nav-logo-sub { font-size:10px; color:var(--text-sub); font-weight:500; align-self:flex-end; margin-bottom:5px; }
    .nav-center {
      flex:1; display:flex; align-items:center; justify-content:center;
      max-width:640px; margin:0 auto;
    }
    .search-form {
      display:flex; width:100%; height:42px; background:var(--surface); border-radius:999px; overflow:hidden;
      border:1px solid var(--border); border-radius:40px; overflow:hidden;
    }
    .search-form:focus-within { border-color:var(--red); }
    .search-form input {
      flex:1; background:transparent; border:none; color:var(--text);
      padding:0 4px 0 16px; outline:none; font-size:16px;
      font-family:'Roboto',Arial,sans-serif;
    }
    .search-btn {
      background:var(--surface); border:none; border-left:1px solid var(--border);
      color:var(--text-sub); width:64px; height:100%;
      display:flex; align-items:center; justify-content:center;
      cursor:pointer; transition:background .1s;
      border-radius:0 40px 40px 0;
    }
    .search-btn:hover { background:var(--hover); }
    .search-btn svg { width:20px; height:20px; fill:currentColor; }
    .nav-right { display:flex; align-items:center; gap:4px; margin-left:auto; flex-shrink:0; }
    /* ===== MAIN ===== */
    .container { max-width:1284px; margin:0 auto; padding:calc(var(--nav-h) + 24px) 24px 60px; }
    .page-title { font-size:28px; font-weight:700; margin-bottom:24px; }
    .empty-state {
      text-align:center; padding:80px 16px; color:var(--text-sub);
    }
    .empty-state svg { width:64px; height:64px; fill:var(--text-sub); opacity:0.4; margin-bottom:16px; }
    .empty-state h2 { font-size:18px; color:var(--text); margin-bottom:8px; }
    .empty-state p { font-size:14px; color:var(--text-sub); }
    .empty-state a {
      display:inline-block; margin-top:20px; padding:10px 20px;
      background:var(--text); color:var(--bg); border-radius:20px;
      text-decoration:none; font-weight:500; font-size:14px;
    }
    .channel-list {
      display:grid; gap:8px;
    }
    .channel-row {
      display:flex; align-items:center; gap:16px;
      padding:12px; border-radius:12px;
      transition:background .15s;
      text-decoration:none; color:inherit;
    }
    .channel-row:hover { background:var(--card); }
    .channel-avatar-wrap {
      width:80px; height:80px; border-radius:50%;
      flex-shrink:0; overflow:hidden;
      display:flex; align-items:center; justify-content:center;
      background:linear-gradient(135deg, #444 0%, #222 100%);
      font-size:32px; font-weight:700; color:#fff;
      position:relative;
    }
    @media (max-width:600px) { .channel-avatar-wrap { width:56px; height:56px; font-size:22px; } }
    .channel-avatar-wrap img {
      width:100%; height:100%; object-fit:cover;
      position:absolute; inset:0; display:none;
    }
    .channel-avatar-wrap img.loaded { display:block; }
    .channel-meta { flex:1; min-width:0; }
    .channel-name {
      font-size:16px; font-weight:500; color:var(--text);
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      margin-bottom:4px;
    }
    .channel-handle { font-size:13px; color:var(--text-sub); margin-bottom:4px; }
    .channel-sub-date { font-size:12px; color:var(--text-sub); }
    .unsub-btn {
      background:var(--card); color:var(--text); border:none;
      padding:0 16px; height:36px; border-radius:18px;
      font-size:14px; font-weight:500; cursor:pointer;
      transition:background .15s; flex-shrink:0;
      font-family:'Roboto',Arial,sans-serif;
    }
    .unsub-btn:hover { background:var(--hover); }
    @media (max-width:600px) {
      .container { padding:calc(var(--nav-h) + 16px) 16px 60px; }
      .page-title { font-size:22px; }
      .channel-handle { display:none; }
      .nav-center { display:none; }
      .unsub-btn { padding:0 12px; font-size:13px; }
    }
  </style>
</head>
<body>
<nav class="navbar">
  <div class="nav-left">
    <button class="icon-btn" onclick="history.back()" aria-label="戻る">
      <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    </button>
    <a href="/" class="nav-logo">
      <svg viewBox="0 0 90 20" xmlns="http://www.w3.org/2000/svg"><g><path d="M27.9727 3.12324C27.6435 1.89323 26.6768 0.926623 25.4468 0.597366C23.2197 0 14.285 0 14.285 0C14.285 0 5.35042 0 3.12323 0.597366C1.89323 0.926623 0.926623 1.89323 0.597366 3.12324C0 5.35042 0 10 0 10C0 10 0 14.6496 0.597366 16.8768C0.926623 18.1068 1.89323 19.0734 3.12323 19.4026C5.35042 20 14.285 20 14.285 20C14.285 20 23.2197 20 25.4468 19.4026C26.6768 19.0734 27.6435 18.1068 27.9727 16.8768C28.5701 14.6496 28.5701 10 28.5701 10C28.5701 10 28.5677 5.35042 27.9727 3.12324Z" fill="#FF0000"/><path d="M11.4253 14.2854L18.8477 10.0004L11.4253 5.71533V14.2854Z" fill="white"/></g><g><path d="M34.6024 13.0036L31.3945 1.41846H34.1932L35.3174 6.6701C35.6043 7.96361 35.8136 9.06662 35.95 9.97913H36.0323C36.1264 9.32532 36.3381 8.22937 36.665 6.68892L37.8291 1.41846H40.6278L37.3799 13.0036V18.561H34.6001V13.0036H34.6024Z" fill="#fff"/><path d="M41.4697 18.1937C40.9053 17.8127 40.5031 17.2204 40.2632 16.4167C40.0257 15.6131 39.9058 14.5436 39.9058 13.2055V11.385C39.9058 10.0345 40.0422 8.94917 40.315 8.13146C40.5878 7.31374 41.0135 6.71912 41.592 6.34763C42.1706 5.97614 42.9296 5.79088 43.8703 5.79088C44.797 5.79088 45.5373 5.97849 46.0971 6.35586C46.6545 6.73322 47.0626 7.32785 47.3236 8.13146C47.5847 8.93742 47.7152 10.0227 47.7152 11.385V13.2055C47.7152 14.5436 47.5882 15.6178 47.3354 16.429C47.0825 17.2428 46.6745 17.835 46.1112 18.2088C45.548 18.5826 44.7864 18.7702 43.8265 18.7702C42.8385 18.7702 42.0341 18.5768 41.4697 18.1937ZM44.6932 16.2496C44.8496 15.8405 44.9295 15.1738 44.9295 14.2473V10.3138C44.9295 9.41391 44.8519 8.75541 44.6932 8.34396C44.5345 7.93016 44.2570 7.7239 43.8584 7.7239C43.4763 7.7239 43.2058 7.93016 43.0471 8.34396C42.8861 8.75776 42.8085 9.41391 42.8085 10.3138V14.2473C42.8085 15.1738 42.8838 15.8428 43.0354 16.2496C43.1871 16.6587 43.4575 16.8649 43.8584 16.8649C44.2570 16.8649 44.5345 16.6587 44.6932 16.2496Z" fill="#fff"/><path d="M58.0824 18.5634H55.8765L55.6313 17.0289H55.5702C54.9705 18.1871 54.0707 18.7661 52.8708 18.7661C52.0406 18.7661 51.4269 18.4937 51.0312 17.9512C50.6354 17.4063 50.4391 16.5557 50.4391 15.397V6.03751H53.2588V15.2332C53.2588 15.7923 53.32 16.1908 53.4422 16.4276C53.5645 16.6645 53.7702 16.7842 54.0566 16.7842C54.3014 16.7842 54.5368 16.7092 54.7628 16.5581C54.9888 16.4069 55.1547 16.2158 55.2675 15.9837V6.03516H58.0824V18.5634Z" fill="#fff"/><path d="M65.4423 0.376898V2.65541H62.6606V18.5635H59.9019V2.65541H57.1202V0.376898H65.4423Z" fill="#fff"/><path d="M72.2378 6.03751V18.5634H70.0319L69.7867 17.0289H69.7256C69.1259 18.1871 68.2261 18.7661 67.0263 18.7661C66.1961 18.7661 65.5823 18.4937 65.1867 17.9512C64.7909 17.4063 64.5945 16.5557 64.5945 15.397V6.03751H67.4142V15.2332C67.4142 15.7923 67.4753 16.1908 67.5976 16.4276C67.7199 16.6645 67.9256 16.7842 68.212 16.7842C68.4568 16.7842 68.6922 16.7092 68.9182 16.5581C69.1442 16.4069 69.3101 16.2158 69.4229 15.9837V6.03516H72.2378V6.03751Z" fill="#fff"/><path d="M81.595 8.0387C81.4239 7.24917 81.1487 6.67797 80.7676 6.32048C80.3866 5.963 79.8621 5.78363 79.1971 5.78363C78.682 5.78363 78.1999 5.92779 77.7531 6.21613C77.3063 6.50447 76.9605 6.8855 76.7204 7.35577H76.6993V0H73.9812V18.5634H76.3094L76.5969 17.3776H76.6581C76.8723 17.8003 77.1939 18.1342 77.6243 18.3823C78.0547 18.6282 78.5345 18.7512 79.0612 18.7512C80.0056 18.7512 80.7041 18.3147 81.1532 17.4404C81.6022 16.5663 81.8281 15.1996 81.8281 13.343V11.4377C81.8281 10.0454 81.7414 8.95015 81.5701 8.16063L81.595 8.0387ZM79.0095 13.1804C79.0095 14.0876 78.972 14.7984 78.8971 15.3128C78.8219 15.8272 78.6962 16.1924 78.5179 16.4082C78.342 16.624 78.1019 16.7319 77.8019 16.7319C77.5688 16.7319 77.3522 16.6779 77.1545 16.5666C76.9568 16.4575 76.7965 16.2934 76.6743 16.0775V8.96154C76.7682 8.6209 76.9329 8.34433 77.166 8.12624C77.3967 7.90814 77.6513 7.79706 77.9255 7.79706C78.2114 7.79706 78.4327 7.90932 78.5862 8.13568C78.7421 8.36437 78.8501 8.74519 78.9112 9.28135C78.9722 9.81752 79.0017 10.5777 79.0017 11.5677V13.1804H79.0095Z" fill="#fff"/><path d="M85.3402 13.7654C85.3402 14.5667 85.3637 15.1671 85.4108 15.5693C85.4579 15.9714 85.5566 16.2645 85.7095 16.4499C85.8624 16.6328 86.0976 16.7257 86.4153 16.7257C86.8443 16.7257 87.1417 16.5586 87.3 16.2268C87.4607 15.8949 87.5476 15.3411 87.5664 14.5687L89.9979 14.7115C90.0114 14.8202 90.0181 14.9706 90.0181 15.1604C90.0181 16.3304 89.6979 17.2046 89.0589 17.7794C88.4199 18.3542 87.5147 18.6429 86.3433 18.6429C84.9367 18.6429 83.9522 18.2009 83.3886 17.3193C82.8226 16.4376 82.5418 15.0735 82.5418 13.2271V11.0166C82.5418 9.11592 82.8344 7.72677 83.4192 6.84966C84.0042 5.97255 85.0052 5.53516 86.4242 5.53516C87.4014 5.53516 88.1518 5.71452 88.6748 6.07556C89.1979 6.43659 89.5664 6.99721 89.7806 7.7593C89.9947 8.52379 90.1017 9.57829 90.1017 10.9268V13.0928H85.3402V13.7654ZM85.6976 7.95405C85.5519 8.13085 85.4569 8.41917 85.4108 8.82126C85.3637 9.22336 85.3402 9.83337 85.3402 10.6535V11.5793H87.4203V10.6535C87.4203 9.84741 87.3919 9.23739 87.3377 8.82126C87.2835 8.40513 87.1885 8.11447 87.0498 7.95405C86.9111 7.79363 86.6997 7.71106 86.4197 7.71106C86.1359 7.71106 85.9241 7.79597 85.6976 7.95405Z" fill="#fff"/></g></svg>
    </a>
  </div>
  <div class="nav-center">
    <form class="search-form" onsubmit="event.preventDefault(); const q=this.querySelector('input').value.trim(); if(q) window.location.href='/?q='+encodeURIComponent(q);">
      <input type="text" placeholder="検索" name="q">
      <button type="submit" class="search-btn">
        <svg viewBox="0 0 24 24"><path d="M20.87 20.17l-5.59-5.59C16.35 13.35 17 11.75 17 10c0-3.87-3.13-7-7-7s-7 3.13-7 7 3.13 7 7 7c1.75 0 3.35-.65 4.58-1.71l5.59 5.59.7-.71zM10 16c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/></svg>
      </button>
    </form>
  </div>
  <div class="nav-right">
    <a href="/" class="icon-btn" title="ホーム">
      <svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
    </a>
  </div>
</nav>

<div class="container">
  <h1 class="page-title">登録チャンネル</h1>
  <div id="content"></div>
</div>

<script>
  const colors = ['#ff0000','#ff6d00','#ffd600','#00c853','#00b0ff','#651fff','#d500f9','#f50057'];
  function colorOf(name) {
    const i = (name||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0) % colors.length;
    return colors[i];
  }
  function getSubscriptions() {
    const list = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('subscribed_') && localStorage.getItem(key) === 'true') {
        const name = key.replace('subscribed_', '');
        let meta = {};
        try {
          const raw = localStorage.getItem('subinfo_' + name);
          if (raw) meta = JSON.parse(raw);
        } catch (e) {}
        list.push({ name, avatar: meta.avatar || '', subscribedAt: meta.subscribedAt || 0 });
      }
    }
    // 新しい順
    list.sort((a, b) => (b.subscribedAt || 0) - (a.subscribedAt || 0));
    return list;
  }
  function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getFullYear() + '/' + (d.getMonth()+1) + '/' + d.getDate() + ' に登録';
  }
  function render() {
    const list = getSubscriptions();
    const content = document.getElementById('content');
    if (list.length === 0) {
      content.innerHTML = \`
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M10 18v-6l5 3-5 3zm7-15H7v1h10V3zm3 3H4v1h16V6zm2 3H2v12h20V9zM4 19V10h16v9H4z"/></svg>
          <h2>登録チャンネルはまだありません</h2>
          <p>気になる動画から「チャンネル登録」ボタンを押してみましょう。</p>
          <a href="/">ホームに戻る</a>
        </div>\`;
      return;
    }
    const html = list.map(ch => {
      const initial = (ch.name[0] || 'C').toUpperCase();
      const bg = colorOf(ch.name);
      const handle = '@' + (ch.name || '').toLowerCase().replace(/\\s+/g, '');
      return \`
        <a href="/channel/\${encodeURIComponent(ch.name)}" class="channel-row">
          <div class="channel-avatar-wrap" style="background:\${bg};">
            <span>\${initial}</span>
            \${ch.avatar ? \`<img src="\${ch.avatar}" alt="\${ch.name}" onload="this.classList.add('loaded')" onerror="this.remove()">\` : ''}
          </div>
          <div class="channel-meta">
            <div class="channel-name">\${ch.name}</div>
            <div class="channel-handle">\${handle}</div>
            <div class="channel-sub-date">\${formatDate(ch.subscribedAt)}</div>
          </div>
          <button class="unsub-btn" onclick="unsub(event, '\${ch.name.replace(/'/g, "\\\\'")}')">登録済み</button>
        </a>\`;
    }).join('');
    content.innerHTML = \`<div class="channel-list">\${html}</div>\`;
    // アバターがない場合は ui-avatars でフォールバック
    list.forEach((ch) => {
      if (!ch.avatar) {
        const rows = document.querySelectorAll('.channel-row');
        rows.forEach(r => {
          if (r.href.endsWith(encodeURIComponent(ch.name))) {
            const wrap = r.querySelector('.channel-avatar-wrap');
            if (wrap && !wrap.querySelector('img')) {
              const img = document.createElement('img');
              img.src = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(ch.name) + '&background=random&color=fff&size=128&bold=true';
              img.alt = ch.name;
              img.onload = () => img.classList.add('loaded');
              img.onerror = () => img.remove();
              wrap.appendChild(img);
            }
          }
        });
      }
    });
  }
  function unsub(e, name) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(name + ' のチャンネル登録を解除しますか？')) return;
    localStorage.removeItem('subscribed_' + name);
    localStorage.removeItem('subinfo_' + name);
    render();
  }
  render();
</script>
</body>
</html>`;
  res.send(html);
});

app.get("/blog", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});

app.get("/game", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});
app.get("/minecraft", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "game/fun/Minecraft.html"));
});

app.get("/play", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "game/play.html"));
});
app.get("/anime", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/anime.html"));
});

app.get("/movie", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/sorry.html"));
});

app.get("/use-api", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/api-portal.html"));
});

app.get("/api-portal", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/api-portal.html"));
});

app.get("/api/docs", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/api-portal.html"));
});

app.get("/version", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "raw/version.json"));
});

// ──────────────────────────────────────────────────────────────────────────
// 拡張 API エンドポイント群 (v1.4)
//  - /api/health        : ヘルスチェック (稼働状況・uptime・メモリ)
//  - /api/stats         : サーバー統計情報
//  - /api/suggest       : 検索サジェスト (YouTube オートコンプリート)
//  - /api/video/:id     : 動画メタデータ (JSON 形式の軽量レスポンス)
//  - /api/version       : バージョン情報 (JSON)
//  - /api/endpoints     : 公開エンドポイント一覧 (自己記述的)
// ──────────────────────────────────────────────────────────────────────────
const SERVER_START_TIME = Date.now();
let API_REQUEST_COUNT = 0;
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) API_REQUEST_COUNT++;
  next();
});

app.get("/api/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    uptime_seconds: Math.round((Date.now() - SERVER_START_TIME) / 1000),
    uptime_human: (() => {
      const s = Math.round((Date.now() - SERVER_START_TIME) / 1000);
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      return `${d}d ${h}h ${m}m ${sec}s`;
    })(),
    memory_mb: {
      rss: +(mem.rss / 1024 / 1024).toFixed(1),
      heap_used: +(mem.heapUsed / 1024 / 1024).toFixed(1),
      heap_total: +(mem.heapTotal / 1024 / 1024).toFixed(1)
    },
    node_version: process.version,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/stats", (req, res) => {
  res.json({
    server_start: new Date(SERVER_START_TIME).toISOString(),
    uptime_seconds: Math.round((Date.now() - SERVER_START_TIME) / 1000),
    api_requests_total: API_REQUEST_COUNT,
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    version: "1.4.0"
  });
});

app.get("/api/version", (req, res) => {
  try {
    const vPath = path.join(__dirname, "public", "raw/version.json");
    const data = JSON.parse(fs.readFileSync(vPath, "utf-8"));
    res.json({ ...data, name: "MIN-Tube-Lite", api: "v1" });
  } catch (e) {
    res.status(500).json({ error: "Failed to read version" });
  }
});

app.get("/api/suggest", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "query parameter 'q' is required" });
  try {
    // YouTube オートコンプリート公式エンドポイント
    const url = `https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&hl=ja&gl=jp&ds=yt&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const text = await r.text();
    // window.google.ac.h([...]) 形式の JSONP を JSON に変換
    const m = text.match(/\[.*\]/s);
    if (!m) return res.json({ query: q, suggestions: [] });
    const parsed = JSON.parse(m[0]);
    const suggestions = Array.isArray(parsed[1]) ? parsed[1].map(it => Array.isArray(it) ? it[0] : it) : [];
    res.set("Cache-Control", "public, max-age=300");
    res.json({ query: q, suggestions });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch suggestions", message: err.message });
  }
});

// コメント返信取得 (Invidious continuation 経由)
app.get("/api/comments-reply/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  const continuation = req.query.continuation || '';
  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) {
    return res.status(400).json({ error: "Invalid video id" });
  }
  try {
    for (const apiBase of apiListCache) {
      try {
        const url = `${apiBase}/api/comments/${videoId}${continuation ? `?continuation=${encodeURIComponent(continuation)}` : ''}`;
        const r = await fetchWithTimeout(url, {}, 4000);
        if (r.ok) {
          const data = await r.json();
          res.set("Cache-Control", "public, max-age=120");
          return res.json(data);
        }
      } catch (_) { continue; }
    }
    return res.status(502).json({ error: "All comment sources failed", comments: [] });
  } catch (err) {
    return res.status(500).json({ error: "Internal Error", message: err.message, comments: [] });
  }
});

app.get("/api/video/:id", async (req, res) => {
  const videoId = req.params.id;
  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) {
    return res.status(400).json({ error: "Invalid video id" });
  }
  // 複数ソースを並列に試行し、最初に成功したものを返す
  const tryYts = async () => {
    const details = await yts.GetVideoDetails(videoId).catch(() => null);
    if (!details) return null;
    return {
      source: "youtube-search-api",
      id: videoId,
      title: details.title || null,
      channel: details.channel || null,
      keywords: details.keywords || [],
      description: details.description || null,
      isLive: !!details.isLive,
      suggestion: details.suggestion || []
    };
  };
  const tryOembed = async () => {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`);
      if (!r.ok) return null;
      const j = await r.json();
      return {
        source: "oembed",
        id: videoId,
        title: j.title || null,
        channel: { name: j.author_name || null, url: j.author_url || null },
        thumbnail_oembed: j.thumbnail_url || null,
        html: j.html || null
      };
    } catch (_) { return null; }
  };
  try {
    let data = await tryYts();
    if (!data) data = await tryOembed();
    if (!data) return res.status(404).json({ error: "Video not found" });
    res.set("Cache-Control", "public, max-age=600");
    res.json({
      ...data,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      url: `/video/${videoId}`
    });
  } catch (err) {
    res.status(500).json({ error: "Internal Error", message: err.message });
  }
});

app.get("/api/endpoints", (req, res) => {
  res.json({
    base: `${req.protocol}://${req.get("host")}`,
    count: 19,
    endpoints: [
      { method: "GET",  path: "/api/trending",          desc: "急上昇動画一覧" },
      { method: "GET",  path: "/api/search",            desc: "動画検索" },
      { method: "GET",  path: "/api/recommendations",   desc: "おすすめ動画" },
      { method: "GET",  path: "/api/channel",           desc: "チャンネル情報" },
      { method: "GET",  path: "/api/inv/channel/:name", desc: "Invidiousチャンネル検索" },
      { method: "GET",  path: "/api/playlist/:id",      desc: "プレイリスト取得" },
      { method: "GET",  path: "/api/auto-playlist",     desc: "自動プレイリスト作成" },
      { method: "GET",  path: "/api/video/:id",         desc: "動画メタデータJSON" },
      { method: "GET",  path: "/api/suggest",           desc: "検索サジェスト" },
      { method: "GET",  path: "/api/health",            desc: "ヘルスチェック" },
      { method: "GET",  path: "/api/stats",             desc: "サーバー統計" },
      { method: "GET",  path: "/api/version",           desc: "バージョン情報JSON" },
      { method: "GET",  path: "/api/endpoints",         desc: "本一覧" },
      { method: "POST", path: "/api/save-history",      desc: "視聴履歴保存" },
      { method: "GET",  path: "/img/:videoId",          desc: "サムネイル取得" },
      { method: "GET",  path: "/360/:videoId",          desc: "360p 直リンク" },
      { method: "GET",  path: "/stream/inv/:videoId",   desc: "Invidiousストリーム" },
      { method: "GET",  path: "/sia-dl/:videoId",       desc: "ダウンロードリンク" },
      { method: "GET",  path: "/ai-fetch/:videoId",     desc: "AIフェッチメタデータ" }
    ]
  });
});
app.get("/ai", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/ac.html"));
});
app.get("/vc", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/Vc.html"));
});
app.get("/code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/Code.html"));
});
app.get("/games.json", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "game/game.json"));
});
app.get("/gust", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/GUST.html"));
});
app.get("/easy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/easy.html"));
});

app.get("/urls", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/public-url.html"));
});

app.get("/own", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy/own.html"));
});

app.get("/wista", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "wista.html"));
});

app.get("/sia", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sia/index.html"));
});

app.get("/science", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/iframe/science.html"));
});

app.get("/earth", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/iframe/earth.html"));
});

app.get("/sys-update", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app/update.html"));
});

app.get("/classroom.192", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "img/classroom.192.png"));
});

app.get("/classroom.512", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "img/classroom.512.png"));
});


app.get("/manifest.json", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "manifest.json"));
});

app.get("/sw.js", (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, "sw.js"));
});

app.get("/api/channel", async (req, res) => {
  const channelName = req.query.name || req.query.id;
  const page = parseInt(req.query.page) || 0;
  if (!channelName) return res.status(400).json({ error: "name required" });
  try {
    // 取得件数を20に設定
    const results = await yts.GetListByKeyword(channelName, false, 20, page);
    const videos = (results.items || []).filter(item => item.type === 'video');
    res.json({ channelName, videos, nextPage: page + 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/inv/channel/:name', async (req, res) => {
  const channelName = req.params.name;

  const url = `https://yt.chocolatemoo53.com/api/v1/search?q=${encodeURIComponent(
    channelName
  )}&type=channel`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Upstream error: ${response.statusText}` });
    }

    const data = await response.json();

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/channel/:channelName", (req, res) => {
  const channelName = decodeURIComponent(req.params.channelName);
  const initial = channelName.charAt(0).toUpperCase();
  // チャンネルごとにアバター背景色を決定（固定色・フォールバック用）
  const colors = ['#ff0000','#ff6d00','#ffd600','#00c853','#00b0ff','#651fff','#d500f9','#f50057'];
  const colorIndex = channelName.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length;
  const avatarBg = colors[colorIndex];

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${channelName} - MIN-Tube-Lite</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
  <script>(function(){try{if(localStorage.getItem('theme')==='light'){document.documentElement.classList.add('light-mode');}}catch(e){}})();</script>
  <style>
    :root {
      --bg:#0f0f0f; --surface:#1c1c1c; --card:#232323; --hover:#303030;
      --text:#f1f1f1; --text-sub:#a0a0a0; --text-sec:#717171;
      --red:#ff4d4d; --border:rgba(255,255,255,0.08);
      --avatar-bg: ${avatarBg};
      --nav-h: 60px;
    }
    html.light-mode {
      --bg:#f7f8fa; --surface:#ffffff; --card:#eef0f3; --hover:#e2e6eb;
      --text:#14161a; --text-sub:#5e6470; --text-sec:#909090;
      --red:#ff3b3b; --border:rgba(0,0,0,0.07);
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { background:var(--bg); color:var(--text); font-family:'Roboto',Arial,sans-serif; -webkit-font-smoothing:antialiased; transition:background .3s,color .3s; }

    /* ===== NAVBAR ===== */
    .navbar {
      position:fixed; top:0; width:100%; height:var(--nav-h);
      background:var(--bg); display:flex; align-items:center;
      padding:0 16px; z-index:1000; gap:8px;
      border-bottom:1px solid transparent;
    }
    .nav-left { display:flex; align-items:center; gap:8px; flex-shrink:0; }
    .icon-btn {
      background:none; border:none; color:var(--text); cursor:pointer;
      width:40px; height:40px; border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      transition:background .15s; flex-shrink:0;
    }
    .icon-btn:hover { background:var(--hover); }
    .icon-btn svg { width:24px; height:24px; fill:var(--text); }
    .nav-logo { display:flex; align-items:center; gap:2px; text-decoration:none; color:var(--text); }
    .nav-logo-icon { background:var(--red); border-radius:6px; width:34px; height:24px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .nav-logo-icon svg { width:16px; height:16px; fill:white; }
    .nav-logo-text { font-size:18px; font-weight:700; letter-spacing:-0.5px; margin-left:4px; }
    .nav-logo-sub { font-size:10px; color:var(--text-sub); font-weight:500; margin-left:1px; align-self:flex-end; margin-bottom:4px; }
    .nav-center {
      flex:1; display:flex; align-items:center; justify-content:center;
      max-width:640px; margin:0 auto;
    }
    .search-form {
      display:flex; width:100%; height:42px;
      border:1px solid var(--border); border-radius:999px; overflow:hidden;
      background:var(--surface);
    }
    .search-form:focus-within { border-color:var(--red); }
    .search-form input {
      flex:1; background:var(--bg); border:none; color:var(--text);
      padding:0 16px; outline:none; font-size:16px;
      font-family:'Roboto',Arial,sans-serif;
    }
    .search-btn {
      background:var(--surface); border:none; border-left:1px solid var(--border);
      color:var(--text-sub); width:64px; height:100%;
      display:flex; align-items:center; justify-content:center;
      cursor:pointer; font-size:18px; transition:background .1s;
    }
    .search-btn:hover { background:var(--hover); }
    .search-btn svg { width:20px; height:20px; fill:currentColor; }
    .nav-right { display:flex; align-items:center; gap:4px; margin-left:auto; flex-shrink:0; }

    /* ===== BANNER ===== */
    .channel-banner {
      margin-top:var(--nav-h); width:100%;
      height:clamp(100px, 18vw, 200px);
      background:linear-gradient(135deg, #1c1c2e 0%, #2d1b4e 40%, #1a2a4a 100%);
      position:relative; overflow:hidden;
    }
    .channel-banner::before {
      content:''; position:absolute; inset:0;
      background:radial-gradient(ellipse at 20% 60%, ${avatarBg}44 0%, transparent 60%);
    }
    .channel-banner::after {
      content:''; position:absolute; inset:0;
      background:radial-gradient(ellipse at 80% 30%, rgba(255,255,255,0.05) 0%, transparent 50%);
    }

    /* ===== CHANNEL HEADER ===== */
    .channel-header-wrap {
      max-width:1284px; margin:0 auto; padding:0 24px 0;
    }
    .channel-header {
      display:flex; align-items:center; gap:24px;
      padding:20px 0 16px;
    }
    .channel-avatar {
      width:80px; height:80px; border-radius:50%;
      background:var(--avatar-bg);
      display:flex; align-items:center; justify-content:center;
      font-size:36px; font-weight:700; color:#fff;
      flex-shrink:0; overflow:hidden; position:relative;
      border:3px solid var(--bg);
    }
    @media (min-width:600px) {
      .channel-avatar { width:160px; height:160px; font-size:64px; }
    }
    .channel-avatar img {
      width:100%; height:100%; object-fit:cover;
      display:none; position:absolute; inset:0;
    }
    .channel-avatar img.loaded { display:block; }
    .avatar-initial { position:relative; z-index:1; }

    .channel-info { flex:1; min-width:0; }
    .channel-title-row { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
    .channel-title {
      font-size:clamp(18px, 4vw, 36px); font-weight:700; line-height:1.2;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .verified-badge { fill:var(--text-sub); width:16px; height:16px; display:none; flex-shrink:0; }
    .verified-badge.show { display:block; }
    .channel-meta {
      font-size:14px; color:var(--text-sub); line-height:1.6;
      margin-bottom:12px;
    }
    .channel-meta span + span::before { content:' • '; }
    .channel-description {
      font-size:14px; color:var(--text-sub); line-height:1.5;
      display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
      overflow:hidden; max-width:600px; margin-bottom:16px;
    }
    .channel-actions { display:flex; align-items:center; gap:8px; }
    .btn-subscribe {
      background:var(--text); color:#0f0f0f;
      border:none; border-radius:20px;
      padding:0 16px; height:36px; font-size:14px; font-weight:500;
      cursor:pointer; transition:opacity .15s;
      font-family:'Roboto',Arial,sans-serif; white-space:nowrap;
      display:flex; align-items:center;
    }
    .btn-subscribe:hover { opacity:0.9; }
    .btn-subscribe.subscribed { background:var(--card); color:var(--text); }
    .btn-subscribe.subscribed:hover { background:var(--hover); }
    .btn-notify {
      background:var(--card); border:none; color:var(--text);
      width:36px; height:36px; border-radius:50%;
      display:none; align-items:center; justify-content:center;
      cursor:pointer; transition:background .15s, transform .2s;
      position:relative;
    }
    .btn-notify.show { display:flex; }
    .btn-notify:hover { background:var(--hover); }
    .btn-notify svg { width:20px; height:20px; fill:var(--text); transition:transform .2s; }
    .btn-notify.notify-on { background:var(--card); }
    .btn-notify.notify-on svg { fill:#ff4081; animation: bell-ring 0.6s ease; }
    @keyframes bell-ring {
      0%,100% { transform: rotate(0); }
      20% { transform: rotate(-15deg); }
      40% { transform: rotate(12deg); }
      60% { transform: rotate(-8deg); }
      80% { transform: rotate(5deg); }
    }

    /* ===== TABS ===== */
    .channel-tabs-wrap {
      max-width:1284px; margin:0 auto; padding:0 24px;
      border-bottom:1px solid var(--border);
    }
    .channel-tabs { display:flex; overflow-x:auto; scrollbar-width:none; }
    .channel-tabs::-webkit-scrollbar { display:none; }
    .tab {
      padding:0 16px; height:48px; cursor:pointer;
      font-size:14px; font-weight:500; letter-spacing:0.3px;
      color:var(--text-sub); border-bottom:2px solid transparent;
      transition:color .15s, border-color .15s; white-space:nowrap;
      display:flex; align-items:center;
    }
    .tab:hover { color:var(--text); background:var(--hover); }
    .tab.active { color:var(--text); border-bottom-color:var(--text); }

    /* ===== CONTENT ===== */
    .content { max-width:1284px; margin:0 auto; padding:20px 24px 60px; }
    .video-grid {
      display:grid;
      grid-template-columns:repeat(auto-fill, minmax(240px,1fr));
      gap:16px; row-gap:40px;
    }
    .video-card { text-decoration:none; color:inherit; display:flex; flex-direction:column; }
    .thumb {
      width:100%; aspect-ratio:16/9; border-radius:12px;
      overflow:hidden; background:var(--card); position:relative;
      margin-bottom:12px;
    }
    .thumb img { width:100%; height:100%; object-fit:cover; display:block; transition:border-radius .2s; }
    .video-card:hover .thumb img { border-radius:0; }
    .duration-badge {
      position:absolute; bottom:6px; right:6px;
      background:rgba(0,0,0,0.85); color:#fff;
      font-size:12px; font-weight:700; padding:2px 5px; border-radius:4px;
    }
    .card-meta { display:flex; gap:12px; align-items:flex-start; }
    .card-ch-avatar {
      width:36px; height:36px; border-radius:50%;
      background:var(--avatar-bg); flex-shrink:0;
      display:flex; align-items:center; justify-content:center;
      font-size:14px; font-weight:700; color:#fff; overflow:hidden;
    }
    .card-ch-avatar img { width:100%; height:100%; object-fit:cover; display:block; }
    .card-info { flex:1; min-width:0; }
    .video-title {
      font-size:14px; font-weight:500; line-height:1.4;
      display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
      overflow:hidden; color:var(--text); margin-bottom:4px;
    }
    .video-ch-name { font-size:13px; color:var(--text-sub); margin-bottom:2px; }
    .video-sub { font-size:13px; color:var(--text-sub); }

    /* ===== LOADING / EMPTY ===== */
    .loading { display:flex; justify-content:center; padding:60px; }
    .spinner {
      border:3px solid #333; border-top-color:var(--red);
      border-radius:50%; width:40px; height:40px;
      animation:spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform:rotate(360deg); } }
    .load-more {
      display:block; margin:32px auto; padding:0 24px; height:36px;
      background:var(--card); border:none; color:var(--text);
      border-radius:18px; font-size:14px; font-weight:500;
      cursor:pointer; transition:background .15s;
      font-family:'Roboto',Arial,sans-serif;
    }
    .load-more:hover { background:var(--hover); }
    .empty { text-align:center; padding:60px; color:var(--text-sub); font-size:15px; }

    /* ===== RESPONSIVE ===== */
    @media (max-width:600px) {
      .channel-header-wrap { padding:0 16px; }
      .channel-header { gap:16px; padding:16px 0 12px; }
      .channel-description { display:none; }
      .content { padding:16px 16px 80px; }
      .video-grid { grid-template-columns:repeat(2,1fr); gap:8px; row-gap:24px; }
      .channel-tabs-wrap { padding:0 16px; }
      .nav-center { display:none; }
    }
  </style>
</head>
<body>

<nav class="navbar">
  <div class="nav-left">
    <button class="icon-btn" onclick="history.back()" aria-label="戻る">
      <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    </button>
    <a href="/" class="nav-logo">
      <div class="nav-logo-icon">
        <svg viewBox="0 0 68 48"><path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="#FF0000"/><path d="M45 24 27 14v20" fill="white"/></svg>
      </div>
      <span class="nav-logo-text">YouTube</span><span class="nav-logo-sub">Pro</span>
    </a>
  </div>
  <div class="nav-center">
    <form class="search-form" action="/nothing/search" onsubmit="event.preventDefault(); const q=this.querySelector('input').value.trim(); if(q) window.location.href='/?q='+encodeURIComponent(q);">
      <input type="text" placeholder="検索" name="q">
      <button type="submit" class="search-btn">
        <svg viewBox="0 0 24 24"><path d="M20.87 20.17l-5.59-5.59C16.35 13.35 17 11.75 17 10c0-3.87-3.13-7-7-7s-7 3.13-7 7 3.13 7 7 7c1.75 0 3.35-.65 4.58-1.71l5.59 5.59.7-.71zM10 16c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/></svg>
      </button>
    </form>
  </div>
  <div class="nav-right">
    <a href="/" class="icon-btn" title="ホーム">
      <svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
    </a>
  </div>
</nav>

<div class="channel-banner"></div>

<div class="channel-header-wrap">
  <div class="channel-header">
    <div class="channel-avatar" id="channelAvatar">
      <img id="channelAvatarImg" src="" alt="">
      <span class="avatar-initial" id="avatarInitial">${initial}</span>
    </div>
    <div class="channel-info">
      <div class="channel-title-row">
        <div class="channel-title" id="channelTitle">${channelName}</div>
        <svg class="verified-badge" id="verifiedBadge" viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zM10 17l-5-5 1.4-1.4 3.6 3.6 7.6-7.6L19 8l-9 9z"/></svg>
      </div>
      <div class="channel-meta">
        <span id="channelHandle">@${channelName.toLowerCase().replace(/\s+/g, '')}</span>
        <span id="subCount"></span>
        <span id="videoCountDisplay"></span>
      </div>
      <div class="channel-description" id="channelDescription"></div>
      <div class="channel-actions">
        <button class="btn-subscribe" id="subscribeBtn" onclick="toggleSubscribe()">チャンネル登録</button>
        <button class="btn-notify" id="notifyBtn" aria-label="通知" title="通知を受け取る" onclick="toggleNotify()">
          <svg id="notifyIconOff" viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
        </button>
      </div>
    </div>
  </div>
</div>

<div class="channel-tabs-wrap">
  <div class="channel-tabs">
    <div class="tab active">動画</div>
    <div class="tab" onclick="alert('近日公開予定')">再生リスト</div>
    <div class="tab" onclick="alert('近日公開予定')">コミュニティ</div>
  </div>
</div>

<div class="content">
  <div id="videoGrid" class="video-grid"></div>
  <div id="loading" class="loading"><div class="spinner"></div></div>
  <button id="loadMoreBtn" class="load-more" style="display:none;" onclick="loadMore()">もっと見る</button>
</div>

<script>
  const CHANNEL_NAME = ${JSON.stringify(channelName)};
  const initial = ${JSON.stringify(initial)};
  let currentPage = 0;
  let isLoading = false;
  let isEnd = false;
  let totalLoaded = 0;
  let channelAvatarUrl = ''; // fetchChannelInfo後に設定される

  // 既存：チャンネル登録管理
  const SUB_KEY = 'subscribed_' + CHANNEL_NAME;
  const NOTIFY_KEY = 'notify_' + CHANNEL_NAME;
  const BELL_ON_SVG = '<svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';
  const BELL_OFF_SVG = '<svg viewBox="0 0 24 24"><path d="M20 18.69L7.84 6.14 5.27 3.49 4 4.76l2.8 2.8v.01c-.52.99-.8 2.16-.8 3.42v5l-2 2v1h13.73l2 2L21 19.72l-1-1.03zM12 22c1.11 0 2-.89 2-2h-4c0 1.11.89 2 2 2zm6-7.32V11c0-3.08-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68c-.15.03-.29.08-.42.12-.1.03-.2.07-.3.11h-.01c-.01 0-.01 0-.02.01-.23.09-.46.18-.68.29 0 0-.01 0-.01.01L18 14.68z"/></svg>';
  function updateSubscribeUI() {
    const isSub = localStorage.getItem(SUB_KEY) === 'true';
    const btn = document.getElementById('subscribeBtn');
    const notifyBtn = document.getElementById('notifyBtn');
    if (isSub) {
      btn.textContent = '登録済み';
      btn.classList.add('subscribed');
      if(notifyBtn) notifyBtn.classList.add('show');
    } else {
      btn.textContent = 'チャンネル登録';
      btn.classList.remove('subscribed');
      if(notifyBtn) notifyBtn.classList.remove('show');
    }
    updateNotifyUI();
  }
  function updateNotifyUI() {
    const notifyBtn = document.getElementById('notifyBtn');
    if (!notifyBtn) return;
    const isOn = localStorage.getItem(NOTIFY_KEY) === 'true';
    if (isOn) {
      notifyBtn.classList.add('notify-on');
      notifyBtn.innerHTML = BELL_ON_SVG;
      notifyBtn.title = '通知をオフにする';
    } else {
      notifyBtn.classList.remove('notify-on');
      notifyBtn.innerHTML = BELL_OFF_SVG;
      notifyBtn.title = '通知を受け取る';
    }
  }
  function toggleSubscribe() {
    const isSub = localStorage.getItem(SUB_KEY) === 'true';
    if (isSub) {
      localStorage.removeItem(SUB_KEY);
      // 登録解除時は通知設定も解除
      localStorage.removeItem(NOTIFY_KEY);
    } else {
      localStorage.setItem(SUB_KEY, 'true');
      // メタ情報も保存（登録チャンネル一覧ページで使用）
      try {
        const meta = {
          name: CHANNEL_NAME,
          avatar: channelAvatarUrl || '',
          subscribedAt: Date.now()
        };
        localStorage.setItem('subinfo_' + CHANNEL_NAME, JSON.stringify(meta));
      } catch (e) {}
    }
    updateSubscribeUI();
  }
  async function toggleNotify() {
    const isOn = localStorage.getItem(NOTIFY_KEY) === 'true';
    if (isOn) {
      localStorage.removeItem(NOTIFY_KEY);
    } else {
      // ブラウザ通知の許可をリクエスト（任意）
      if ('Notification' in window && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch (e) {}
      }
      localStorage.setItem(NOTIFY_KEY, 'true');
    }
    updateNotifyUI();
  }
  window.toggleNotify = toggleNotify;

  // 既存：フォーマット関数
  function formatViews(v) {
    if (!v) return '';
    return v.replace('views', '回視聴').replace('ago', '前');
  }
  function formatSubscribers(n) {
    if (!n) return 'チャンネル';
    return n;
  }

  // 動画描画
  function renderVideos(videos) {
    const grid = document.getElementById('videoGrid');
    if (videos.length === 0 && totalLoaded === 0) {
      grid.innerHTML = '<div class="empty">動画が見つかりませんでした</div>';
      return;
    }
    const html = videos.map(v => \`
      <a href="/video/\${v.id}" class="video-card">
        <div class="thumb">
          <img src="https://i.ytimg.com/vi/\${v.id}/mqdefault.jpg" loading="lazy">
          \${v.lengthText ? \`<div class="duration-badge">\${v.lengthText}</div>\` : ''}
        </div>
        <div class="card-meta">
          <div class="card-ch-avatar" style="position:relative;overflow:hidden;">
            <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:inherit;">\${initial}</span>
            \${channelAvatarUrl ? \`<img src="\${channelAvatarUrl}" alt="\${CHANNEL_NAME}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.remove()">\` : ''}
          </div>
          <div class="card-info">
            <div class="video-title">\${v.title || ''}</div>
            <div class="video-ch-name">\${CHANNEL_NAME}</div>
            <div class="video-sub">\${formatViews(v.viewCountText) || ''}</div>
          </div>
        </div>
      </a>
    \`).join('');
    grid.insertAdjacentHTML('beforeend', html);
    totalLoaded += videos.length;
    const countDisp = document.getElementById('videoCountDisplay');
    if (countDisp) countDisp.textContent = '動画 ' + totalLoaded + ' 本';
  }

  // 動画取得コア関数
  async function loadVideos() {
    if (isLoading || isEnd) return;
    isLoading = true;
    document.getElementById('loading').style.display = 'flex';
    
    try {
      const res = await fetch(\`/api/channel?name=\${encodeURIComponent(CHANNEL_NAME)}&page=\${currentPage}\`);
      const data = await res.json();
      if (!data.videos || data.videos.length === 0) {
        isEnd = true;
        document.getElementById('loading').innerHTML = '<p style="color:var(--text-sub);padding:20px;">すべての動画を読み込みました</p>';
      } else {
        renderVideos(data.videos);
        currentPage = data.nextPage;
      }
    } catch (e) {
      isEnd = true;
    } finally {
      isLoading = false;
      if (!isEnd) document.getElementById('loading').style.display = 'none';
    }
  }

  // 追加：無限スクロール監視 (Intersection Observer)
  function initInfiniteScroll() {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadVideos();
    }, { rootMargin: '400px' });
    observer.observe(document.getElementById('loading'));
  }

  // 既存：チャンネル情報取得
  async function fetchChannelInfo() {
    try {
      const res = await fetch(\`/api/inv/channel/\${encodeURIComponent(CHANNEL_NAME)}\`);
      const data = await res.json();
      const c = Array.isArray(data) ? data[0] : data;
      if (c) {
        if (c.authorThumbnails?.length) {
          const avatarSrc = c.authorThumbnails[c.authorThumbnails.length-1].url;
          channelAvatarUrl = avatarSrc; // renderVideos で使用
          const img = document.getElementById('channelAvatarImg');
          img.src = avatarSrc;
          img.onload = () => { img.classList.add('loaded'); document.getElementById('avatarInitial').style.display='none'; };
        }
        if (c.description) document.getElementById('channelDescription').textContent = c.description;
        if (c.subCount) document.getElementById('subCount').textContent = c.subCount + ' 人の登録者';
      }
    } catch(e) {}
  }

  // 初期化
  async function init() {
    updateSubscribeUI();
    await fetchChannelInfo();
    await loadVideos(); // 初回20件
    initInfiniteScroll(); // 以降自動
  }
  init();
</script>
</body>
</html>`;
  res.send(html);
});


app.get('/stream/inv/:videoId', async (req, res) => {
    const videoId = req.params.videoId;
    const now = Date.now();

    if (videoCache.has(videoId)) {
        const cached = videoCache.get(videoId);
        if (now < cached.expiry) {
            return res.type('text/plain').send(cached.url);
        }
    }

    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
    
    try {
        const configRes = await fetch("https://raw.githubusercontent.com/mino-hobby-pro/min-tube-pro-local-txt/refs/heads/main/inv-check.txt");
        const extraParams = (await configRes.text()).trim(); 
        
        const targetUrl = `https://yt-comp5.chocolatemoo53.com/companion/latest_version?id=${videoId}${extraParams}`;

        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                "User-Agent": randomUA,
                "Accept": "*/*"
            },
            redirect: 'follow'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const finalUrl = response.url;


        videoCache.set(videoId, {
            url: finalUrl,
            expiry: now + 60000
        });

        res.type('text/plain').send(finalUrl);

    } catch (error) {
        console.error('Error fetching the URL:', error.message);
        res.status(500).send('Internal Server Error');
    }
});

app.get("/img/:videoId", (req, res) => {
    const { videoId } = req.params;

    const url = `https://i3.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    https.get(url, (ytRes) => {
        if (ytRes.statusCode !== 200) {
            res.status(ytRes.statusCode).send("Failed to fetch image");
            return;
        }

        res.setHeader("Content-Type", "image/jpeg");

        // サーバー負荷を軽減するためそのままデータを転送してます
        ytRes.pipe(res);

    }).on("error", (err) => {
        console.error("Image proxy error:", err);
        res.status(500).send("Proxy error");
    });
});

app.get('/get-other/:videoId', async (req, res) => {
    const { videoId } = req.params;
    
    const apiOrder = shuffleArray(Object.keys(apiHandlers));
    
    let result = null;
    let errors = [];

    for (const apiName of apiOrder) {
        try {
            console.log(`Trying API: ${apiName}`);
            result = await apiHandlers[apiName](videoId);
            if (result) {
                result.provider = apiName;
                break; 
            }
        } catch (error) {
            console.error(`❌ ${apiName} failed: ${error.message}`);
            errors.push({ api: apiName, error: error.message });
        }
    }

    if (!result) {
        return res.status(500).json({
            success: false,
            message: "えらー",
            details: errors
        });
    }

    try {
        const seenUrls = new Set();
        if (result.stream_url) seenUrls.add(result.stream_url);

        result.streamUrls = (result.streamUrls || []).filter(s => {
            if (!s.url || seenUrls.has(s.url)) return false;
            seenUrls.add(s.url);
            
            if (s.resolution) {
                s.resolution = String(s.resolution).replace(/ \(.+\)/g, '').trim();
                if (s.fps && s.resolution.endsWith(String(s.fps))) {
                    s.resolution = s.resolution.slice(0, -String(s.fps).length).trim();
                }
            }
            
            if (s.url.includes('.m3u8') || s.url.includes('manifest')) {
                s.container = 'm3u8';
            }
            return true;
        });

        const isInvalid = (url) => !url || url.includes('manifest') || url.includes('.m3u8');
        if (isInvalid(result.audioUrl)) {
            result.audioUrl = '';
            result.audioUrls = [];
        } else {
            result.audioUrls = (result.audioUrls || []).filter(s => !isInvalid(s.url));
        }

        return res.json({
            success: true,
            data: result
        });

    } catch (cleanError) {
        return res.json({
            success: true,
            data: result,
            note: "Cleaning process partially failed"
        });
    }
});

const calculateScore = (v) => {
    const [major, minor, patch] = v.split('.').map(Number);
    return (major * 1000) + (minor * 100) + (patch * 10);
};

app.get('/check-version', async (req, res) => {
    const remoteUrl = 'https://raw.githubusercontent.com/Sou930/MIN-Tube-Lite/refs/heads/main/public/raw/version.json';
    const localPath = path.join(__dirname, 'public', 'raw', 'version.json');

    try {
        const [remoteRes, localRaw] = await Promise.all([
            fetch(remoteUrl),
            fs.promises.readFile(localPath, 'utf8')
        ]);

        if (!remoteRes.ok) throw new Error('Could not reach remote version server');
        
        const remoteData = await remoteRes.json();
        const localData = JSON.parse(localRaw);

        const latestVersion = remoteData.version;
        const currentVersion = localData.version;


        const latestScore = calculateScore(latestVersion);
        const currentScore = calculateScore(currentVersion);
        

        const updateDiff = Math.max(0, latestScore - currentScore);


        res.json({
            is_latest: currentScore >= latestScore,
            latest_version: latestVersion,
            current_version: currentVersion,
            updates_count: updateDiff,
            status: "success"
        });

    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

const memoryCache = new Map();
const CACHE_TTL = 10 * 60 * 100; 
const MAX_CACHE_SIZE = 50;      


function setCache(key, value) {
  if (memoryCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = memoryCache.keys().next().value;
    memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, { data: value, timestamp: Date.now() });
}

const isValidId = (id) => /^[a-zA-Z0-9_-]{11}$/.test(id); 
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";


app.get("/short-check/:id", async (req, res) => {
  const videoId = req.params.id;

  if (!isValidId(videoId)) {
    return res.status(400).json({ error: "Invalid video ID format" });
  }

  const cacheKey = `short:${videoId}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return res.json(cached.data);
  }

  try {
    const response = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT }
    });

    if (response.status === 429) {
      return res.status(429).json({ error: "YouTube rate limit exceeded." });
    }

    let isShort = false;
    let exists = true;

    if (response.status === 200) {
      isShort = true;
    } else if (response.status === 302 || response.status === 303) {
      isShort = false; 
    } else if (response.status === 404) {
      exists = false;
    }

    const result = { videoId, exists, isShort };
    setCache(cacheKey, result);

    res.setHeader("Cache-Control", "public, max-age=180, s-maxage=300");
    return res.json(result);

  } catch (error) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "public", "error.html")));
app.use((err, req, res, next) => {
  res.status(500).sendFile(path.join(__dirname, "public", "error.html"));
});

app.listen(port, () => console.log(`Server is running on port \${port}`));
