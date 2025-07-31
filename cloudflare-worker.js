// Cloudflare Worker - OCI Alarm to Telegram forwarder
export default {
  async fetch(request, env, ctx) {
    // Handle GET requests for health checks
    if (request.method === 'GET') {
      return new Response('Oracle Cloud Infrastructure Webhook Endpoint - Ready', { status: 200 });
    }
    
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const rawBody = await request.text();
      
      if (!rawBody || rawBody.trim().length === 0) {
        return new Response('Empty request body', { status: 400 });
      }
      
      // Parse JSON with error handling for Oracle Cloud formatting issues
      let alarmData;
      try {
        alarmData = JSON.parse(rawBody);
      } catch (jsonError) {
        // Try to fix common JSON issues from Oracle Cloud (unescaped quotes)
        let fixedBody = rawBody;
        fixedBody = fixedBody.replace(/(":\s*")([^"]*)"([^"]*)"([^"]*?)(")/g, '$1$2\\"$3\\"$4$5');
        fixedBody = fixedBody.replace(/("alarmSummary":\s*")([^"]*?)"([^"]*?)"([^"]*?)(")/g, '$1$2\\"$3\\"$4$5');
        
        try {
          alarmData = JSON.parse(fixedBody);
        } catch (secondError) {
          return new Response(`Invalid JSON: ${jsonError.message}`, { status: 400 });
        }
      }
      
      // Check for Oracle Cloud subscription confirmation
      const messageType = request.headers.get('x-oci-ns-messagetype');
      const confirmationUrlHeader = request.headers.get('x-oci-ns-confirmationurl');
      
      const isConfirmationRequest = messageType === 'SubscriptionConfirmation' || 
                                  confirmationUrlHeader ||
                                  (alarmData && (
                                    alarmData.eventType === 'com.oraclecloud.ons.subscriptionconfirmation' ||
                                    alarmData.ConfirmationURL ||
                                    alarmData.confirmationUrl
                                  ));
      
      if (isConfirmationRequest) {
        const confirmationUrl = confirmationUrlHeader ||
                               alarmData?.ConfirmationURL ||
                               alarmData?.confirmationUrl;
        
        if (confirmationUrl) {
          const confirmResponse = await fetch(confirmationUrl, {
            method: 'GET',
            headers: {
              'User-Agent': 'CloudflareWorker/1.0',
              'Accept': '*/*'
            }
          });
          
          if (confirmResponse.ok) {
            return new Response('Subscription confirmed successfully', { status: 200 });
          } else {
            return new Response('Failed to confirm subscription', { status: 500 });
          }
        } else {
          return new Response('No confirmation URL provided', { status: 400 });
        }
      }

      // Handle regular alarm notifications
      const message = formatAlarmMessage(alarmData);
      const telegramResponse = await sendToTelegram(message, env);
      
      if (telegramResponse.ok) {
        return new Response('Message sent successfully', { status: 200 });
      } else {
        const error = await telegramResponse.text();
        console.error('Telegram API error:', error);
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
    const status = alarmData?.type || 'UNKNOWN';
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
    message += `*Severity:* ${alarmData?.severity || 'INFO'}\n`;
    message += `*Time:* ${alarmData?.timestamp || 'Unknown time'}\n`;
    
    if (alarmData?.title) {
      message += `*Alert:* ${alarmData.title}\n`;
    }
    
    // Add resource information
    if (alarmData?.alarmMetaData?.[0]?.dimensions?.[0]) {
      const dimension = alarmData.alarmMetaData[0].dimensions[0];
      if (dimension.resourceDisplayName) {
        message += `*Resource:* ${dimension.resourceDisplayName}\n`;
      }
      if (dimension.shape) {
        message += `*Instance Type:* ${dimension.shape}\n`;
      }
      if (dimension.region) {
        message += `*Region:* ${dimension.region}\n`;
      }
    }
    
    // Add metric values
    if (alarmData?.alarmMetaData?.[0]?.metricValues?.[0]) {
      const metrics = alarmData.alarmMetaData[0].metricValues[0];
      Object.keys(metrics).forEach(key => {
        const value = parseFloat(metrics[key]);
        if (!isNaN(value)) {
          const metricName = key.includes('Cpu') ? 'CPU Usage' : key;
          message += `*${metricName}:* ${value.toFixed(1)}%\n`;
        }
      });
    }
    
    // Add alarm summary
    if (alarmData?.alarmMetaData?.[0]?.alarmSummary) {
      let summary = alarmData.alarmMetaData[0].alarmSummary;
      if (summary.length > 200) {
        summary = summary.substring(0, 200) + '...';
      }
      message += `*Details:* ${summary}\n`;
    }
    
    // Add console link
    if (alarmData?.alarmMetaData?.[0]?.alarmUrl) {
      message += `[View in Console](${alarmData.alarmMetaData[0].alarmUrl})\n`;
    }
    
    return message;
    
  } catch (error) {
    console.error('Error formatting message:', error);
    return `🚨 *Oracle VM Alert*\n\nReceived alarm but failed to parse details.\nError: ${error.message}`;
  }
}

async function sendToTelegram(message, env) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }
  
  if (!env.TELEGRAM_CHAT_ID) {
    throw new Error('TELEGRAM_CHAT_ID not configured');
  }
  
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
