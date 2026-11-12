# Going live on YouTube with Orbit Royale and Ward 13

Both games run in a browser page that you add to OBS. Your computer runs a small server that
reads your YouTube live chat and passes it to the game, so viewers play by typing in chat.

| Game | Page for the stream | What chat does |
|---|---|---|
| Orbit Royale | `http://localhost:3000/orbit-royale.html?live` | Type a country to spawn it, type it again to boost it |
| Ward 13 | `http://localhost:3000/ward13.html?live` | Vote `HELP` or `HAUNT`; `!join` to be the next survivor |

## 1. One-time setup

1. Install [Node.js](https://nodejs.org) (version 18 or newer) and [OBS Studio](https://obsproject.com).
2. In this project folder, run `npm install`.
3. Get a YouTube API key (free):
   1. Go to <https://console.cloud.google.com>, create a project.
   2. Open **APIs & Services → Library**, search **YouTube Data API v3**, click **Enable**.
   3. Open **APIs & Services → Credentials → Create credentials → API key**. Copy it.
   4. Click the key, under **API restrictions** choose **YouTube Data API v3**. Keep it private.
4. Find your channel ID: YouTube Studio → **Settings → Channel → Advanced settings** (starts with `UC`).

## 2. Every stream

1. In YouTube Studio click **Create → Go live**, set the title, and copy the **stream key** into
   OBS (**Settings → Stream → Service: YouTube**). Never paste the stream key anywhere else.
2. Start the server with your key and channel ID.

   Windows (PowerShell):
   ```powershell
   $env:YT_API_KEY="your-api-key"; $env:YT_CHANNEL_ID="UCxxxxxxxx"; $env:YT_POLL_MS="25000"; npm start
   ```
   Mac / Linux:
   ```bash
   YT_API_KEY=your-api-key YT_CHANNEL_ID=UCxxxxxxxx YT_POLL_MS=25000 npm start
   ```
   If you already know the live video's ID, use `YT_VIDEO_ID=...` instead of `YT_CHANNEL_ID`
   (it saves 100 quota units per connection).
3. In OBS add a **Browser** source: URL from the table above, width **1920**, height **1080**,
   tick **Control audio via OBS** so the game's sound goes on stream.
4. Click **Start Streaming** in OBS. The server log shows `[youtube chat] connected` once the
   stream is live (it checks every minute until it is).
5. Check the connection any time at `http://localhost:3000/api/chat/status`.

## 3. API quota: how long you can stream per day

A Google project gets **10,000 quota units per day** (resets at midnight Pacific time).
Reading chat costs about **5 units** per request and the like count about **1 unit per minute**.

| `YT_POLL_MS` (chat check every…) | Hours of streaming per day |
|---|---|
| 10000 (10 s) | about 5 hours |
| 25000 (25 s) | about 12 hours |
| 40000 (40 s) | about 18 hours |

Chat messages are never lost between checks; they just arrive in a batch. That is why Ward 13's
voting window is 30 s by default (change it with `?vote=45`). For faster chat on long streams,
request more quota in the Google Cloud console (**IAM & Admin → Quotas**, free, takes a few days).

## 4. Testing without going live

- Without `YT_API_KEY`, open `orbit-royale.html` (demo bots play) or `ward13.html?auto`.
- Send a fake chat message to the live pages:
  ```bash
  curl -X POST localhost:3000/api/chat -H "content-type: application/json" -d '{"user":"me","text":"HAUNT"}'
  ```
- Set the like counter: `curl -X POST localhost:3000/api/likes -H "content-type: application/json" -d '{"likes":250}'`

These test endpoints only accept requests from your own computer.

## 5. Stream tips (from the channel research)

- Run long streams (8–12 hours, the length that worked for the flag-battle channel). YouTube
  saves replays up to 12 hours, so end and restart before that.
- One stream at a time, at the same times each week.
- Orbit Royale: press **C** at the end to download round-winner timestamps and paste them into
  the replay's description as chapters.
- Clip the best moments (a jumpscare, a last-second escape, a comeback win) into Shorts that
  point to the next stream.

## Troubleshooting

| Log message | Fix |
|---|---|
| `off: set YT_API_KEY…` | The environment variables were not set in the same terminal as `npm start`. |
| `waiting: No live stream found` | The stream isn't live yet; it retries every minute. |
| `quotaExceeded` | Daily quota used up. Raise `YT_POLL_MS` or request more quota. |
| `API key not valid` | Re-copy the key and check the YouTube Data API v3 is enabled. |
| An error about login or permission when reading chat | Some channels need sign-in to read chat with the API; ask for the OAuth sign-in option to be added. |
