// Cloudflare Worker - OCI Alarm to Telegram forwarder
export default {
  async fetch(request, env, ctx) {
    // Only handle POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Parse the alarm data from OCI ONS
      const alarmData = await request.json();
      console.log('Received alarm data:', JSON.stringify(alarmData, null, 2));

      // Format message for Telegram
      const message = formatAlarmMessage(alarmData);

      // Send to Telegram
      const telegramResponse = await sendToTelegram(message, env);
      
      if (telegramResponse.ok) {
        return new Response('Message sent successfully', { status: 200 });
      } else {
        console.error('Telegram API error:', await telegramResponse.text());
        return new Response('Failed to send message', { status: 500 });
      }

    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal server error', { status: 500 });
    }
  }
};

function formatAlarmMessage(alarmData) {
  try {
    // Determine status and emoji
    const status = alarmData.type || 'UNKNOWN';
    let emoji = 'ℹ️';
    let statusText = status;

    if (status === 'FIRING_TO_OK') {
      emoji = '✅';
      statusText = 'RESOLVED';
    } else if (status === 'OK_TO_FIRING') {
      emoji = '🔥';
      statusText = 'FIRING';
    }

    // Build message
    let message = `${emoji} *Oracle VM Alert*\n\n`;
    message += `*Status:* ${statusText}\n`;
    
    // Add severity
    const severity = alarmData.severity || 'INFO';
    message += `*Severity:* ${severity}\n`;
    
    // Add timestamp
    const timestamp = alarmData.timestamp || 'Unknown time';
    message += `*Time:* ${timestamp}\n`;
    
    // Add title
    if (alarmData.title) {
      message += `*Alert:* ${alarmData.title}\n`;
    }
    
    // Add alarm details from metadata
    if (alarmData.alarmMetaData && alarmData.alarmMetaData.length > 0) {
      const alarmMeta = alarmData.alarmMetaData[0];
      
      if (alarmMeta.alarmSummary) {
        let summary = alarmMeta.alarmSummary;
        if (summary.length > 200) {
          summary = summary.substring(0, 200) + '...';
        }
        message += `*Details:* ${summary}\n`;
      }
      
      if (alarmMeta.alarmUrl) {
        message += `[View in Console](${alarmMeta.alarmUrl})\n`;
      }
    }
    
    return message;
    
  } catch (error) {
    console.error('Error formatting message:', error);
    return `🚨 *Oracle VM Alert*\n\nReceived alarm but failed to parse details.\nRaw: ${JSON.stringify(alarmData).substring(0, 300)}...`;
  }
}

async function sendToTelegram(message, env) {
  const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };
  
  return fetch(telegramUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload)
  });
}
