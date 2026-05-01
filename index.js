const https = require('https');
const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = '1GYvE8y6At2UsGg8_vXO8pS2NvFfH82eT8DF4WWK7HEY';

app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch (e) { req.body = {}; }
    next();
  });
});

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getGoogleAccessToken() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');
  
  const { createSign } = require('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(credentials.private_key, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;
  
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const result = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  return result.access_token;
}

async function getSheetData() {
  const token = await getGoogleAccessToken();
  const result = await httpsRequest({
    hostname: 'sheets.googleapis.com',
    path: `/v4/spreadsheets/${SPREADSHEET_ID}/values/A1:Z100`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!result.values) return 'データが見つかりませんでした。';
  return result.values.map(row => row.join('\t')).join('\n');
}

async function sendSlackMessage(channel, text, thread_ts) {
  const body = JSON.stringify(thread_ts ? { channel, text, thread_ts } : { channel, text });
  const data = await httpsRequest({
    hostname: 'slack.com',
    path: '/api/chat.postMessage',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Length': Buffer.byteLength(body) }
  }, body);
  console.log('Slack response:', data);
  return data;
}

async function askClaude(question, sheetData) {
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `あなたはGoogleスプレッドシートのデータを分析・解説するアシスタントです。以下のスプレッドシートデータを参照して日本語で答えてください。\n\nスプレッドシートデータ:\n${sheetData}`,
    messages: [{ role: 'user', content: question }]
  });
  const data = await httpsRequest({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  console.log('Claude response:', data);
  return data.content?.[0]?.text || 'エラーが発生しました。';
}

const processedEvents = new Set();

app.post('/slack/events', async (req, res) => {
  console.log('Slack event received:', JSON.stringify(req.body));
  if (req.body.type === 'url_verification') return res.json({ challenge: req.body.challenge });
  res.status(200).send('OK');
  const event = req.body.event;
  if (!event || event.type !== 'app_mention') return;
  const eventId = req.body.event_id;
  if (processedEvents.has(eventId)) return;
  processedEvents.add(eventId);
  setTimeout(() => { processedEvents.delete(eventId); }, 60000);
  const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  try {
    await sendSlackMessage(event.channel, 'スプレッドシートを確認中...', event.ts);
    const sheetData = await getSheetData();
    const answer = question ? await askClaude(question, sheetData) : '質問内容を入力してください。';
    await sendSlackMessage(event.channel, answer, event.ts);
  } catch (err) {
    console.error('Error:', err);
    await sendSlackMessage(event.channel, `エラーが発生しました: ${err.message}`, event.ts);
  }
});

app.get('/', (req, res) => { res.send('Slack Bot is running!'); });
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
