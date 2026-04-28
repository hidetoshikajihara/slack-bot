const https = require('https');
const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch (e) { req.body = {}; }
    next();
  });
});

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendSlackMessage(channel, text, thread_ts) {
  const body = JSON.stringify(thread_ts ? { channel, text, thread_ts } : { channel, text });
  const data = await httpsPost('slack.com', '/api/chat.postMessage', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    'Content-Length': Buffer.byteLength(body)
  }, body);
  console.log('Slack response:', data);
  return data;
}

async function askClaude(question) {
  const body = JSON.stringify({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: 'あなたはGoogleスプレッドシートのデータを分析・解説するアシスタントです。日本語で答えてください。',
    messages: [{ role: 'user', content: question }]
  });
  const data = await httpsPost('api.anthropic.com', '/v1/messages', {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'Content-Length': Buffer.byteLength(body)
  }, body);
  console.log('Claude response:', data);
  return data.content?.[0]?.text || 'エラーが発生しました。';
}

const processedEvents = new Set();

app.post('/slack/events', async (req, res) => {
  console.log('Slack event received:', JSON.stringify(req.body));
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }
  res.status(200).send('OK');
  const event = req.body.event;
  if (!event || event.type !== 'app_mention') return;
  const eventId = req.body.event_id;
  if (processedEvents.has(eventId)) return;
  processedEvents.add(eventId);
  setTimeout(() => { processedEvents.delete(eventId); }, 60000);
  const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  try {
    const answer = question ? await askClaude(question) : '質問内容を入力してください。';
    await sendSlackMessage(event.channel, answer, event.ts);
  } catch (err) {
    console.error('Error:', err);
    await sendSlackMessage(event.channel, 'エラーが発生しました。', event.ts);
  }
});

app.get('/', (req, res) => { res.send('Slack Bot is running!'); });
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
