// Reads a YouTube live stream's chat and like count with the official YouTube Data API v3.
//
// Needs an API key (YT_API_KEY) and either the live video's ID (YT_VIDEO_ID) or your
// channel ID (YT_CHANNEL_ID, used to find whichever stream is live right now).
//
// Quota: a default API project gets 10,000 units/day. Reading chat costs about 5 units
// per request, so the poll interval (YT_POLL_MS, default 10s) is what decides how many
// hours a day you can stream. See STREAMING.md for the numbers.

const BASE = process.env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startYouTubeChat({ apiKey, videoId, channelId, pollMs = 10000, likesMs = 60000, onMessage, onLikes, onStatus }) {
  let stopped = false, gen = 0;
  const status = (s) => onStatus && onStatus(s);

  async function api(path, params) {
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    url.searchParams.set('key', apiKey);
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason;
      const err = new Error((body.error && body.error.message) || `HTTP ${res.status}`);
      err.reason = reason; err.status = res.status;
      throw err;
    }
    return body;
  }

  async function findLiveVideo() {
    if (videoId) return videoId;
    // search.list is expensive (100 units), so it is only used once per connection attempt
    const j = await api('search', { part: 'id', channelId, eventType: 'live', type: 'video', maxResults: 1 });
    return j.items && j.items[0] && j.items[0].id && j.items[0].id.videoId;
  }

  async function connect() {
    const id = await findLiveVideo();
    if (!id) throw Object.assign(new Error('No live stream found on that channel yet'), { reason: 'notLive' });
    const j = await api('videos', { part: 'liveStreamingDetails,statistics', id });
    const v = j.items && j.items[0];
    const chatId = v && v.liveStreamingDetails && v.liveStreamingDetails.activeLiveChatId;
    if (!chatId) throw Object.assign(new Error('That video has no active live chat (is the stream live?)'), { reason: 'notLive' });
    if (onLikes && v.statistics) onLikes(Number(v.statistics.likeCount) || 0);
    return { id, chatId };
  }

  async function likesLoop(id, g) {
    while (!stopped && onLikes && g === gen) {
      await sleep(likesMs);
      try {
        const j = await api('videos', { part: 'statistics', id });
        const v = j.items && j.items[0];
        if (v && v.statistics) onLikes(Number(v.statistics.likeCount) || 0);
      } catch (e) { /* likes are optional; keep chat running */ }
    }
  }

  (async function main() {
    while (!stopped) {
      let conn;
      try {
        status({ state: 'connecting' });
        conn = await connect();
        status({ state: 'connected', videoId: conn.id });
      } catch (e) {
        status({ state: 'waiting', error: e.message });
        await sleep(e.reason === 'notLive' ? 60000 : 30000);
        continue;
      }
      const g = ++gen;
      likesLoop(conn.id, g);
      let pageToken, first = true;
      while (!stopped) {
        try {
          const j = await api('liveChat/messages', { liveChatId: conn.chatId, part: 'snippet,authorDetails', maxResults: 200, pageToken });
          pageToken = j.nextPageToken;
          // skip the backlog that was posted before we connected
          if (!first) for (const m of j.items || []) {
            const text = m.snippet && (m.snippet.displayMessage || (m.snippet.textMessageDetails && m.snippet.textMessageDetails.messageText));
            const user = m.authorDetails && m.authorDetails.displayName;
            if (text && user) onMessage({ user, text });
          }
          first = false;
          await sleep(Math.max(pollMs, j.pollingIntervalMillis || 0));
        } catch (e) {
          status({ state: 'error', error: e.message });
          if (['liveChatEnded', 'liveChatNotFound', 'liveChatDisabled', 'forbidden'].includes(e.reason)) break; // reconnect
          if (e.reason === 'quotaExceeded' || e.reason === 'rateLimitExceeded') { await sleep(10 * 60000); continue; }
          await sleep(15000);
        }
      }
      if (!stopped) await sleep(30000);
    }
  })();

  return { stop() { stopped = true; } };
}

module.exports = { startYouTubeChat };
