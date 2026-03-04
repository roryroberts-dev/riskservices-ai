// ============================================================
// BUILDMYSITE — Contact Form Handler
// Receives form submissions, validates, sends email via Resend.
// Falls back to logging if Resend is not configured.
// ============================================================

import { Resend } from 'resend';

// Simple in-memory rate limiter (per IP, resets on cold start)
const submissions = new Map();
const RATE_LIMIT = 5;         // max submissions
const RATE_WINDOW = 600_000;  // per 10 minutes

function isRateLimited(ip) {
  const now = Date.now();
  const record = submissions.get(ip);
  if (!record || now - record.firstAt > RATE_WINDOW) {
    submissions.set(ip, { count: 1, firstAt: now });
    return false;
  }
  record.count++;
  return record.count > RATE_LIMIT;
}

// Basic input sanitisation — strip HTML tags
function sanitise(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim();
}

// Validate email format
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  // Rate limit by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
  }

  // Parse and validate input
  const name    = sanitise(req.body?.name);
  const email   = sanitise(req.body?.email);
  const phone   = sanitise(req.body?.phone || '');
  const message = sanitise(req.body?.message);

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }

  if (name.length > 200 || email.length > 200 || phone.length > 50 || message.length > 5000) {
    return res.status(400).json({ error: 'Input exceeds maximum length.' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  // Determine recipient
  const contactEmail = process.env.CONTACT_EMAIL;
  const resendKey    = process.env.RESEND_API_KEY;

  // If Resend is configured, send the email
  if (resendKey && contactEmail) {
    try {
      const resend = new Resend(resendKey);
      await resend.emails.send({
        from: 'BuildMySite Contact <onboarding@resend.dev>',
        to: contactEmail,
        replyTo: email,
        subject: `New message from ${name}`,
        html: `
          <h2>New Contact Form Submission</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          ${phone ? `<p><strong>Phone:</strong> ${phone}</p>` : ''}
          <hr>
          <p>${message.replace(/\n/g, '<br>')}</p>
          <hr>
          <p style="color: #888; font-size: 12px;">Sent via your website contact form, powered by BuildMySite.</p>
        `.trim()
      });
      return res.status(200).json({ success: true, message: 'Message sent successfully.' });
    } catch (err) {
      console.error('Resend error:', err);
      return res.status(500).json({ error: 'Failed to send message. Please try again or contact us directly.' });
    }
  }

  // Fallback: log to Vercel console (no email configured yet)
  console.log('--- Contact Form Submission ---');
  console.log(`Name: ${name}`);
  console.log(`Email: ${email}`);
  if (phone) console.log(`Phone: ${phone}`);
  console.log(`Message: ${message}`);
  console.log('--- (RESEND_API_KEY or CONTACT_EMAIL not configured — email not sent) ---');

  return res.status(200).json({
    success: true,
    message: 'Message received.',
    _note: 'Email delivery not configured. Set RESEND_API_KEY and CONTACT_EMAIL environment variables.'
  });
}
