export const isMock = () => process.env.OTP_MODE === 'mock';

export async function sendSms(phone, message) {
  if (isMock()) return true;
  const key = process.env.TERMII_API_KEY;
  const from = process.env.TERMII_SENDER;
  if (!key || !from) throw new Error('SMS provider not configured');
  // Termii generic SMS endpoint. Verify sender ID approval and DND routing before going live.
  const r = await fetch('https://api.ng.termii.com/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: `234${phone.slice(1)}`, from, sms: message, type: 'plain', channel: 'generic', api_key: key })
  });
  return r.ok;
}
