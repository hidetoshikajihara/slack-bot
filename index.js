const https = require('https');
const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = '1GYvE8y6At2UsGg8_vXO8pS2NvFfH82eT8DF4WWK7HEY';

const SHEET_NAMES = [
  '26SS靴下', '25AW靴下', '24AW靴下', '24SS靴下', '23AW靴下', '23SS靴下',
  '22AW靴下', '22SS靴下', '21AW靴下', '21SS靴下', '20AW靴下', '20SS靴下',
  '19AW靴下', '19SS靴下', '18AW靴下', '26SSウェア', '25AWウェア', '25SSウェア',
  '24AWウェア', '24SSウェア', '23AWウェア', '23SSウェア', '22AWウェア',
  'ドッグウェア', 'ドッグポンチョ', 'ドッグリード', 'タオル'
];

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

function detectSheetFromQuestion(question) {
  for (const name of SHEET_NAMES) {
    if (question.includes(name)) return name;
  }
  if (question.includes('靴下')) {
    const seasons = ['26SS','25AW','24AW','24SS','23AW','23SS','22AW','22SS','21AW','21SS','20AW','20SS','19AW','19SS','18AW'];
    for (const s of seasons) {
      if (question.includes(s)) return `${s}靴下`;
    }
    return '26SS靴下';
  }
  if (question.includes('ウェア')) {
    const seasons = ['26SS','25AW','25SS','24AW','24SS','23AW','23SS','22AW'];
    for (const s of seasons) {
      if (question.includes(s)) return `${s}ウェア`;
    }
    return '26SSウェア';
  }
  if (question.includes('ドッグ') || question.includes('犬')) return 'ドッグウェア';
  if (question.includes('タオル')) return 'タオル';
  if (question.includes('リード')) return 'ドッグリード';
  if (question.includes('ポンチョ')) return 'ドッグポンチョ';
  return null;
}

async function getSheetData(sheetName) {
  const token = await getGoogleAccessToken();
  const encodedSheet = encodeURIComponent(sheetName);
  const result = await httpsRequest({
    hostname: 'sheets.googleapis.com',
    path: `/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodedSheet}!A1:Z200`,
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

async function askClaude(question, sheetData, sheetName) {
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `あなたはCOQ KANAKO KAJIHARAの在庫管理アシスタントです。「${sheetName}」シートのデータを参照して日本語で答えてください。\n\nシートデータ:\n${sheetData}`,
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
    const sheetName = detectSheetFromQuestion(question);
    if (!sheetName) {
      const sheetList = SHEET_NAMES.join('、');
      await sendSlackMessage(event.channel, `どのシートを参照しますか？\n利用可能なシート：${sheetList}`, event.ts);
      return;
    }
    await sendSlackMessage(event.channel, `「${sheetName}」を確認中...`, event.ts);
    const sheetData = await getSheetData(sheetName);
    const answer = await askClaude(question, sheetData, sheetName);
    await sendSlackMessage(event.channel, answer, event.ts);
  } catch (err) {
    console.error('Error:', err);
    await sendSlackMessage(event.channel, `エラーが発生しました: ${err.message}`, event.ts);
  }
});

app.get('/', (req, res) => { res.send('Slack Bot is running!'); });
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
