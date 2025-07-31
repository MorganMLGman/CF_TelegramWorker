// Cloudflare Worker - OCI Alarm to Telegram forwarder
export default {
  async fetch(request, env, ctx) {
    // Handle both GET and POST requests
    if (request.method === 'GET') {
      // Oracle Cloud might send GET request for health check
      return new Response('Oracle Cloud Infrastructure Webhook Endpoint - Ready', { status: 200 });
    }
    
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Get raw request body first
      const rawBody = await request.text();
      console.log('Received raw body (first 500 chars):', rawBody.substring(0, 500));
      console.log('Body length:', rawBody.length);
      
      // Log the problematic section if the body is long enough
      if (rawBody.length > 1220) {
        console.log('JSON around position 1200-1220:', rawBody.substring(1190, 1230));
      }
      
      // Try to parse JSON
      let alarmData;
      try {
        alarmData = JSON.parse(rawBody);
      } catch (jsonError) {
        console.error('JSON parsing error:', jsonError.message);
        console.error('Invalid JSON around position 1200-1220:', rawBody.substring(1190, 1230));
        
        // Try to fix common JSON issues from Oracle Cloud
        console.log('Attempting to fix malformed JSON...');
        let fixedBody = rawBody;
        
        // Fix unescaped quotes in string values (common Oracle Cloud issue)
        // This regex finds: "key":"value with "unescaped" quotes"
        fixedBody = fixedBody.replace(/(":\s*")([^"]*)"([^"]*)"([^"]*?)(")/g, '$1$2\\"$3\\"$4$5');
        
        // Additional fix for quotes in alarm summaries specifically
        fixedBody = fixedBody.replace(/("alarmSummary":\s*")([^"]*?)"([^"]*?)"([^"]*?)(")/g, '$1$2\\"$3\\"$4$5');
        
        try {
          alarmData = JSON.parse(fixedBody);
          console.log('Successfully fixed and parsed JSON');
        } catch (secondError) {
          console.error('Failed to fix JSON:', secondError.message);
          return new Response(`Invalid JSON that cannot be fixed: ${jsonError.message}`, { status: 400 });
        }
      }
      
      console.log('Parsed alarm data:', JSON.stringify(alarmData, null, 2));

      // Check if this is a subscription confirmation request from Oracle
      if (alarmData && alarmData.eventType === 'com.oraclecloud.ons.subscriptionconfirmation') {
        console.log('Received Oracle Cloud subscription confirmation request');
        
        // Oracle expects us to make a GET request to the confirmationUrl
        if (alarmData.confirmationUrl) {
          console.log('Confirming subscription at:', alarmData.confirmationUrl);
          
          try {
            const confirmResponse = await fetch(alarmData.confirmationUrl, {
              method: 'GET',
              headers: {
                'User-Agent': 'CloudflareWorker/1.0'
              }
            });
            
            if (confirmResponse.ok) {
              console.log('Successfully confirmed Oracle Cloud subscription');
              return new Response('Subscription confirmed successfully', { status: 200 });
            } else {
              console.error('Failed to confirm subscription:', confirmResponse.status, await confirmResponse.text());
              return new Response('Failed to confirm subscription', { status: 500 });
            }
          } catch (confirmError) {
            console.error('Error confirming subscription:', confirmError);
            return new Response('Error confirming subscription', { status: 500 });
          }
        } else {
          console.error('No confirmationUrl provided in subscription confirmation request');
          return new Response('No confirmation URL provided', { status: 400 });
        }
      }

      // Handle regular alarm notifications
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
    console.log('Formatting message for alarm data keys:', Object.keys(alarmData || {}));
    
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
    
    // Add severity
    const severity = alarmData?.severity || 'INFO';
    message += `*Severity:* ${severity}\n`;
    
    // Add timestamp
    const timestamp = alarmData?.timestamp || 'Unknown time';
    message += `*Time:* ${timestamp}\n`;
    
    // Add title
    if (alarmData?.title) {
      message += `*Alert:* ${alarmData.title}\n`;
    }
    
    // Add alarm details from metadata
    if (alarmData?.alarmMetaData && Array.isArray(alarmData.alarmMetaData) && alarmData.alarmMetaData.length > 0) {
      const alarmMeta = alarmData.alarmMetaData[0];
      
      // Add resource information
      if (alarmMeta?.dimensions && Array.isArray(alarmMeta.dimensions) && alarmMeta.dimensions.length > 0) {
        const dimension = alarmMeta.dimensions[0];
        if (dimension?.resourceDisplayName) {
          message += `*Resource:* ${dimension.resourceDisplayName}\n`;
        }
        if (dimension?.shape) {
          message += `*Instance Type:* ${dimension.shape}\n`;
        }
        if (dimension?.region) {
          message += `*Region:* ${dimension.region}\n`;
        }
      }
      
      // Add metric values
      if (alarmMeta?.metricValues && Array.isArray(alarmMeta.metricValues) && alarmMeta.metricValues.length > 0) {
        const metrics = alarmMeta.metricValues[0];
        if (metrics && typeof metrics === 'object') {
          Object.keys(metrics).forEach(key => {
            try {
              const value = parseFloat(metrics[key]);
              if (!isNaN(value)) {
                const metricName = key.includes('Cpu') ? 'CPU Usage' : key;
                message += `*${metricName}:* ${value.toFixed(1)}%\n`;
              }
            } catch (e) {
              console.warn('Error parsing metric value:', key, metrics[key]);
            }
          });
        }
      }
      
      if (alarmMeta?.alarmSummary) {
        let summary = alarmMeta.alarmSummary;
        if (summary.length > 200) {
          summary = summary.substring(0, 200) + '...';
        }
        message += `*Details:* ${summary}\n`;
      }
      
      if (alarmMeta?.alarmUrl) {
        message += `[View in Console](${alarmMeta.alarmUrl})\n`;
      }
    }
    
    return message;
    
  } catch (error) {
    console.error('Error formatting message:', error);
    return `🚨 *Oracle VM Alert*\n\nReceived alarm but failed to parse details.\nError: ${error.message}\nRaw: ${JSON.stringify(alarmData).substring(0, 300)}...`;
  }
}

async function sendToTelegram(message, env) {
  // Check if required environment variables are set
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN environment variable is not set');
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }
  
  if (!env.TELEGRAM_CHAT_ID) {
    console.error('TELEGRAM_CHAT_ID environment variable is not set');
    throw new Error('TELEGRAM_CHAT_ID not configured');
  }
  
  const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  console.log('Sending to Telegram URL:', telegramUrl.replace(env.TELEGRAM_BOT_TOKEN, '[HIDDEN]'));
  
  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };
  
  console.log('Telegram payload:', JSON.stringify({
    ...payload,
    chat_id: '[HIDDEN]'
  }, null, 2));
  
  return fetch(telegramUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload)
  });
}
