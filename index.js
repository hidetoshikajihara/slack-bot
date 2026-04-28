const fetch = require('node-fetch');
const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  let data = '';

  req.on('data', chunk => {
    data += chunk;
  });

  req.on('end', () => {
    req.rawBody = data;

    try {
      req.body = JSON.parse(data);
    } catch (e) {
      req.body = {};
    }

    next();
  });
});

function verifySlackSignature(req) {
  const slackSignature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!slackSignature || !timestamp || !signingSecret) {
    return false;
  }

  const baseString = `v0:${timestamp}:${req.rawBody}`;
  const hmac = crypto.createHmac('sha256', signingSecret);
  hmac.update(baseString);

  const mySignature = `v0=${hmac.digest('hex')}`;

  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(slackSignature)
  );
}

async function sendSlackMessage(channel, text, thread_ts) {
  const body = {
    channel,
    text
  };

  if (thread_ts) {
    body.thread_ts = thread_ts;
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  console.log('Slack response:', data);

  return data;
}

async function askClaude(question) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system:
        'あなたはGoogleスプレッドシートのデータを分析・解説するアシスタントです。スプレッドシートについての質問に日本語で答えてください。',
      messages: [
        {
          role: 'user',
          content: question
        }
      ]
    })
  });

  const data = await response.json();
  console.log('Claude response:', data);

  return data.content?.[0]?.text || 'エラーが発生しました。';
}

const processedEvents = new Set();

app.post('/slack/events', async (req, res) => {
  console.log('Slack event received:', req.body);

  if (req.body.type === 'url_verification') {
    return res.json({
      challenge: req.body.challenge
    });
  }

  if (!verifySlackSignature(req)) {
    console.log('Slack signature verification failed');
    return res.status(401).send('Unauthorized');
  }

  res.status(200).send('OK');

  const event = req.body.event;

  if (!event) return;
  if (event.type !== 'app_mention') return;

  const eventId = req.body.event_id;

  if (processedEvents.has(eventId)) return;

  processedEvents.add(eventId);

  setTimeout(() => {
    processedEvents.delete(eventId);
  }, 60000);

  const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!question) {
    await sendSlackMessage(
      event.channel,
      '質問内容を入力してください。',
      event.ts
    );
    return;
  }

  try {
    // まずはClaudeを使わず、Slack返信テスト
    const answer = 'テスト返信です';

    await sendSlackMessage(event.channel, answer, event.ts);
  } catch (err) {
    console.error('Error:', err);

    await sendSlackMessage(
      event.channel,
      'エラーが発生しました。',
      event.ts
    );
  }
});

app.get('/', (req, res) => {
  res.send('Slack Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
