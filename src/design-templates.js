'use strict';
// Built-in starter templates (Phase 2). Each template is a REAL editable
// design: layers, not a flattened image. The editor loads the template's
// design JSON into a project, where every layer stays editable.
const { blankDesign, defaultTextLayer, defaultShapeLayer } = require('./design-model');
const { blankTimeline, defaultClip } = require('./video-model');
const ds = require('./docs-slides');

// --- v2.2.4: 12 more design templates ---------------------------------------
// Every template is a REAL editable design: layers, not a flattened image.
// Text is sized to fit its box (the never-overflow rule); the test suite
// fit-checks every built-in template.

function eidPost() {
  const d = blankDesign(1080, 1080);
  d.background = { type: 'gradient', color: '#0b3d2e', gradient: { from: '#0b3d2e', to: '#14532d', angle: 135 } };
  const moon = defaultShapeLayer('ellipse', 440, 90, 200, 200, { fill: '#fbbf24', name: 'Moon' });
  const moonCut = defaultShapeLayer('ellipse', 480, 70, 200, 200, { fill: '#0b3d2e', name: 'Moon shadow' });
  const headline = defaultTextLayer(90, 360, 'EID\nMUBARAK', { w: 900, h: 360, fontSize: 150, fontWeight: 800, color: '#fde68a', lineHeight: 1.05 });
  const sub = defaultTextLayer(190, 690, 'Warm wishes to you and your family', { w: 760, h: 60, fontSize: 36, fontWeight: 400, color: '#d1fae5' });
  const cta = defaultShapeLayer('rect', 340, 800, 400, 88, { fill: '#fbbf24', radius: 44, name: 'CTA button' });
  const ctaText = defaultTextLayer(340, 818, 'CELEBRATE', { w: 400, h: 54, fontSize: 34, fontWeight: 800, color: '#0b3d2e' });
  d.layers = [moon, moonCut, headline, sub, cta, ctaText];
  return d;
}

function productLaunch() {
  const d = blankDesign(1080, 1080);
  d.background = { type: 'color', color: '#ffffff', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const kicker = defaultTextLayer(90, 110, 'INTRODUCING', { w: 900, h: 50, fontSize: 34, fontWeight: 700, color: '#7c5cff', letterSpacing: 6 });
  const headline = defaultTextLayer(90, 180, 'The New\nGlow Serum', { w: 900, h: 312, fontSize: 130, fontWeight: 800, color: '#111832', align: 'left', lineHeight: 1.05 });
  const sub = defaultTextLayer(90, 500, 'Vitamin C + Hyaluronic acid.\nVisible glow in 14 days.', { w: 800, h: 120, fontSize: 38, fontWeight: 400, color: '#475569', align: 'left', lineHeight: 1.4 });
  const price = defaultShapeLayer('rect', 90, 660, 320, 110, { fill: '#f5f0e8', radius: 20, name: 'Price box' });
  const priceText = defaultTextLayer(90, 680, 'Rs. 1,499', { w: 320, h: 70, fontSize: 48, fontWeight: 800, color: '#111832' });
  const cta = defaultShapeLayer('rect', 90, 820, 420, 90, { fill: '#7c5cff', radius: 45, name: 'CTA button' });
  const ctaText = defaultTextLayer(90, 838, 'SHOP NOW', { w: 420, h: 54, fontSize: 34, fontWeight: 800, color: '#ffffff' });
  d.layers = [kicker, headline, sub, price, priceText, cta, ctaText];
  return d;
}

function foodPromo() {
  const d = blankDesign(1080, 1080);
  d.background = { type: 'gradient', color: '#7f1d1d', gradient: { from: '#991b1b', to: '#7f1d1d', angle: 135 } };
  const badge = defaultShapeLayer('rect', 340, 90, 400, 70, { fill: '#fbbf24', radius: 35, name: 'Badge' });
  const badgeText = defaultTextLayer(340, 102, 'WEEKEND DEAL', { w: 400, h: 46, fontSize: 30, fontWeight: 800, color: '#7f1d1d' });
  const headline = defaultTextLayer(90, 220, 'Zinger Burger\n+ Fries', { w: 900, h: 312, fontSize: 108, fontWeight: 800, color: '#ffffff', lineHeight: 1.05 });
  const price = defaultTextLayer(90, 540, 'Only Rs. 499', { w: 900, h: 90, fontSize: 72, fontWeight: 800, color: '#fbbf24' });
  const sub = defaultTextLayer(190, 660, 'Dine-in · Takeaway · Delivery', { w: 700, h: 54, fontSize: 34, fontWeight: 400, color: '#fecaca' });
  const cta = defaultShapeLayer('rect', 340, 780, 400, 90, { fill: '#ffffff', radius: 45, name: 'CTA button' });
  const ctaText = defaultTextLayer(340, 798, 'ORDER NOW', { w: 400, h: 54, fontSize: 34, fontWeight: 800, color: '#991b1b' });
  d.layers = [badge, badgeText, headline, price, sub, cta, ctaText];
  return d;
}

function realEstate() {
  const d = blankDesign(1080, 1080);
  d.background = { type: 'color', color: '#f8fafc', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const photo = defaultShapeLayer('rect', 60, 60, 960, 480, { fill: '#1e293b', radius: 24, name: 'Photo placeholder' });
  const photoText = defaultTextLayer(60, 260, 'YOUR PROPERTY PHOTO', { w: 960, h: 60, fontSize: 36, fontWeight: 700, color: '#94a3b8' });
  const headline = defaultTextLayer(90, 580, '5 Marla House\nfor Sale', { w: 900, h: 230, fontSize: 96, fontWeight: 800, color: '#0f172a', align: 'left', lineHeight: 1.05 });
  const detail = defaultTextLayer(90, 800, '3 Bed · 2 Bath · DHA Lahore', { w: 900, h: 54, fontSize: 36, fontWeight: 500, color: '#475569', align: 'left' });
  const price = defaultTextLayer(90, 880, 'PKR 1.25 Crore', { w: 900, h: 70, fontSize: 56, fontWeight: 800, color: '#7c5cff', align: 'left' });
  const foot = defaultTextLayer(90, 980, 'Call 0300 0000000 · www.youragency.com', { w: 900, h: 44, fontSize: 28, fontWeight: 400, color: '#64748b', align: 'left' });
  d.layers = [photo, photoText, headline, detail, price, foot];
  return d;
}

function fitnessChallenge() {
  const d = blankDesign(1080, 1350);
  d.background = { type: 'gradient', color: '#111827', gradient: { from: '#111827', to: '#1f2937', angle: 160 } };
  const bar = defaultShapeLayer('rect', 0, 0, 1080, 18, { fill: '#22c55e', radius: 0, name: 'Top bar' });
  const kicker = defaultTextLayer(90, 120, '30-DAY CHALLENGE', { w: 900, h: 50, fontSize: 34, fontWeight: 700, color: '#22c55e', letterSpacing: 5 });
  const headline = defaultTextLayer(90, 200, 'Stronger\nEvery Day', { w: 900, h: 336, fontSize: 140, fontWeight: 800, color: '#ffffff', align: 'left', lineHeight: 1.05 });
  const sub = defaultTextLayer(90, 540, 'No gym needed. 20 minutes a day.\nStart today, feel it in a week.', { w: 900, h: 130, fontSize: 36, fontWeight: 400, color: '#d1d5db', align: 'left', lineHeight: 1.4 });
  const days = defaultShapeLayer('rect', 90, 720, 900, 200, { fill: '#1f2937', radius: 20, name: 'Days card' });
  const daysText = defaultTextLayer(90, 760, 'DAY 1 — 20 squats · 10 push-ups', { w: 900, h: 60, fontSize: 40, fontWeight: 700, color: '#ffffff' });
  const daysSub = defaultTextLayer(90, 830, 'Full plan inside the app', { w: 900, h: 50, fontSize: 30, fontWeight: 400, color: '#9ca3af' });
  const cta = defaultShapeLayer('rect', 90, 1000, 900, 100, { fill: '#22c55e', radius: 50, name: 'CTA button' });
  const ctaText = defaultTextLayer(90, 1022, 'JOIN FREE', { w: 900, h: 56, fontSize: 38, fontWeight: 800, color: '#052e16' });
  d.layers = [bar, kicker, headline, sub, days, daysText, daysSub, cta, ctaText];
  return d;
}

function weddingInvite() {
  const d = blankDesign(1080, 1350);
  d.background = { type: 'color', color: '#fdf6ec', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const frame = defaultShapeLayer('rect', 50, 50, 980, 1250, { fill: '#ffffff', stroke: '#d4af37', strokeWidth: 3, radius: 8, name: 'Frame' });
  const kicker = defaultTextLayer(140, 160, 'TOGETHER WITH THEIR FAMILIES', { w: 800, h: 44, fontSize: 26, fontWeight: 500, color: '#92400e', letterSpacing: 3 });
  const names = defaultTextLayer(140, 260, 'Aisha\n&\nBilal', { w: 800, h: 396, fontSize: 110, fontWeight: 700, color: '#78350f', fontFamily: 'Playfair Display', lineHeight: 1.1 });
  const rule = defaultShapeLayer('rect', 480, 680, 120, 4, { fill: '#d4af37', radius: 2, name: 'Rule' });
  const invite = defaultTextLayer(140, 730, 'request the honour of your presence\nat their wedding', { w: 800, h: 100, fontSize: 32, fontWeight: 400, color: '#57534e', lineHeight: 1.4 });
  const date = defaultTextLayer(140, 880, 'Saturday · 12 December 2026', { w: 800, h: 54, fontSize: 36, fontWeight: 700, color: '#111832' });
  const venue = defaultTextLayer(140, 950, 'Pearl Continental Hotel, Lahore', { w: 800, h: 50, fontSize: 30, fontWeight: 400, color: '#57534e' });
  const foot = defaultTextLayer(140, 1150, 'Reception to follow · 7:00 PM', { w: 800, h: 44, fontSize: 26, fontWeight: 400, color: '#a8a29e' });
  d.layers = [frame, kicker, names, rule, invite, date, venue, foot];
  return d;
}

function concertPoster() {
  const d = blankDesign(1080, 1350);
  d.background = { type: 'gradient', color: '#0b1020', gradient: { from: '#312e81', to: '#0b1020', angle: 140 } };
  const kicker = defaultTextLayer(90, 120, 'LIVE IN CONCERT', { w: 900, h: 50, fontSize: 34, fontWeight: 700, color: '#22d3ee', letterSpacing: 6 });
  const headline = defaultTextLayer(90, 200, 'THE MIDNIGHT\nSESSIONS', { w: 900, h: 320, fontSize: 98, fontWeight: 800, color: '#ffffff', align: 'left', lineHeight: 1.05 });
  const line = defaultShapeLayer('rect', 90, 560, 200, 8, { fill: '#7c5cff', radius: 4, name: 'Accent line' });
  const detail = defaultTextLayer(90, 620, 'Friday · 20 November 2026\nAlhamra Arts Council, Lahore', { w: 900, h: 120, fontSize: 38, fontWeight: 400, color: '#c7d2fe', align: 'left', lineHeight: 1.4 });
  const ticket = defaultShapeLayer('rect', 90, 800, 420, 110, { fill: '#7c5cff', radius: 16, name: 'Ticket box' });
  const ticketText = defaultTextLayer(90, 820, 'TICKETS', { w: 420, h: 40, fontSize: 28, fontWeight: 700, color: '#c7d2fe' });
  const ticketPrice = defaultTextLayer(90, 858, 'Rs. 2,500', { w: 420, h: 44, fontSize: 34, fontWeight: 800, color: '#ffffff' });
  const cta = defaultShapeLayer('rect', 90, 980, 900, 100, { fill: '#ffffff', radius: 50, name: 'CTA button' });
  const ctaText = defaultTextLayer(90, 1002, 'BOOK YOUR SEAT', { w: 900, h: 56, fontSize: 38, fontWeight: 800, color: '#312e81' });
  d.layers = [kicker, headline, line, detail, ticket, ticketText, ticketPrice, cta, ctaText];
  return d;
}

function linkedinBanner() {
  const d = blankDesign(1584, 396);
  d.background = { type: 'gradient', color: '#0a66c2', gradient: { from: '#0a66c2', to: '#004182', angle: 120 } };
  const headline = defaultTextLayer(80, 90, 'Helping brands grow with design & video', { w: 1360, h: 90, fontSize: 56, fontWeight: 800, color: '#ffffff', align: 'left' });
  const sub = defaultTextLayer(80, 190, 'Creative Director · 10+ years · 200+ launches', { w: 1100, h: 50, fontSize: 30, fontWeight: 400, color: '#dbeafe', align: 'left' });
  const pill = defaultShapeLayer('rect', 80, 260, 260, 60, { fill: '#ffffff', radius: 30, name: 'Pill' });
  const pillText = defaultTextLayer(80, 272, 'OPEN TO WORK', { w: 260, h: 36, fontSize: 24, fontWeight: 800, color: '#0a66c2' });
  const logo = defaultShapeLayer('ellipse', 1360, 120, 150, 150, { fill: '#ffffff', name: 'Logo mark' });
  const logoText = defaultTextLayer(1360, 155, 'CS', { w: 150, h: 80, fontSize: 56, fontWeight: 800, color: '#0a66c2' });
  d.layers = [headline, sub, pill, pillText, logo, logoText];
  return d;
}

function saleBannerWide() {
  const d = blankDesign(1600, 900);
  d.background = { type: 'gradient', color: '#111832', gradient: { from: '#7c5cff', to: '#111832', angle: 120 } };
  const badge = defaultShapeLayer('rect', 100, 110, 300, 64, { fill: '#f59e0b', radius: 32, name: 'Badge' });
  const badgeText = defaultTextLayer(100, 122, 'FLASH SALE', { w: 300, h: 40, fontSize: 28, fontWeight: 800, color: '#111832' });
  const headline = defaultTextLayer(100, 210, 'Up to 70% Off\nEverything', { w: 1080, h: 312, fontSize: 130, fontWeight: 800, color: '#ffffff', align: 'left', lineHeight: 1.05 });
  const sub = defaultTextLayer(100, 500, 'Today only · No code needed · While stocks last', { w: 1000, h: 54, fontSize: 34, fontWeight: 400, color: '#c7d2fe', align: 'left' });
  const cta = defaultShapeLayer('rect', 100, 620, 380, 96, { fill: '#ffffff', radius: 48, name: 'CTA button' });
  const ctaText = defaultTextLayer(100, 640, 'SHOP THE SALE', { w: 380, h: 56, fontSize: 34, fontWeight: 800, color: '#7c5cff' });
  const big = defaultTextLayer(1180, 300, '70%', { w: 320, h: 220, fontSize: 135, fontWeight: 800, color: '#f59e0b' });
  d.layers = [badge, badgeText, headline, sub, cta, ctaText, big];
  return d;
}

function motivational2() {
  const d = blankDesign(1080, 1080);
  d.background = { type: 'color', color: '#0f172a', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const mark = defaultTextLayer(90, 140, '“', { w: 200, h: 264, fontSize: 220, fontWeight: 700, color: '#22d3ee', fontFamily: 'Playfair Display', align: 'left' });
  const quote = defaultTextLayer(140, 360, 'Small steps\nevery day\nbecome big\nresults.', { w: 800, h: 480, fontSize: 96, fontWeight: 800, color: '#ffffff', fontFamily: 'Poppins', align: 'left', lineHeight: 1.15 });
  const rule = defaultShapeLayer('rect', 140, 880, 120, 8, { fill: '#22d3ee', radius: 4, name: 'Rule' });
  const author = defaultTextLayer(140, 920, '— Keep going.', { w: 800, h: 50, fontSize: 34, fontWeight: 500, color: '#94a3b8', align: 'left' });
  d.layers = [mark, quote, rule, author];
  return d;
}

function priceList() {
  const d = blankDesign(1080, 1350);
  d.background = { type: 'color', color: '#ffffff', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const header = defaultShapeLayer('rect', 0, 0, 1080, 300, { fill: '#111832', radius: 0, name: 'Header' });
  const kicker = defaultTextLayer(90, 80, 'OUR MENU', { w: 900, h: 46, fontSize: 30, fontWeight: 700, color: '#f59e0b', letterSpacing: 5 });
  const headline = defaultTextLayer(90, 140, 'Fresh & Tasty', { w: 900, h: 104, fontSize: 84, fontWeight: 800, color: '#ffffff', align: 'left' });
  const rows = [
    ['Chicken Karahi (Half)', 'Rs. 850'],
    ['Chicken Biryani', 'Rs. 350'],
    ['Beef Nihari', 'Rs. 650'],
    ['Seekh Kabab (4 pc)', 'Rs. 550'],
    ['Fresh Lime Soda', 'Rs. 150'],
  ];
  const layers = [header, kicker, headline];
  rows.forEach(([name, price], i) => {
    const y = 380 + i * 130;
    layers.push(defaultTextLayer(90, y, name, { w: 640, h: 56, fontSize: 38, fontWeight: 600, color: '#1e293b', align: 'left' }));
    layers.push(defaultTextLayer(740, y, price, { w: 250, h: 56, fontSize: 38, fontWeight: 800, color: '#7c5cff', align: 'right' }));
    if (i < rows.length - 1) layers.push(defaultShapeLayer('rect', 90, y + 80, 900, 2, { fill: '#e2e8f0', radius: 1, name: 'Divider' }));
  });
  const foot = defaultTextLayer(90, 1120, 'Dine-in · Takeaway · Home delivery 0300 0000000', { w: 900, h: 44, fontSize: 28, fontWeight: 400, color: '#64748b' });
  layers.push(foot);
  d.layers = layers;
  return d;
}

function appPromoStory() {
  const d = blankDesign(1080, 1920);
  d.background = { type: 'gradient', color: '#7c5cff', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 160 } };
  const phone = defaultShapeLayer('rect', 290, 260, 500, 900, { fill: '#0b1020', radius: 48, name: 'Phone' });
  const phoneScreen = defaultShapeLayer('rect', 320, 290, 440, 840, { fill: '#151d3a', radius: 36, name: 'Phone screen' });
  const appName = defaultTextLayer(320, 600, 'Your App', { w: 440, h: 70, fontSize: 52, fontWeight: 800, color: '#ffffff' });
  const appTag = defaultTextLayer(320, 680, 'Design anything,\nanywhere.', { w: 440, h: 110, fontSize: 34, fontWeight: 400, color: '#c7d2fe', lineHeight: 1.3 });
  const headline = defaultTextLayer(80, 1280, 'Create on\nthe go.', { w: 920, h: 288, fontSize: 120, fontWeight: 800, color: '#ffffff', lineHeight: 1.05 });
  const sub = defaultTextLayer(140, 1560, 'Free download · No card needed', { w: 800, h: 54, fontSize: 32, fontWeight: 400, color: '#e8ecf8' });
  const cta = defaultShapeLayer('rect', 290, 1680, 500, 96, { fill: '#ffffff', radius: 48, name: 'CTA button' });
  const ctaText = defaultTextLayer(290, 1700, 'DOWNLOAD NOW', { w: 500, h: 56, fontSize: 34, fontWeight: 800, color: '#3b82f6' });
  d.layers = [phone, phoneScreen, appName, appTag, headline, sub, cta, ctaText];
  return d;
}

// --- v2.2.4: video templates -------------------------------------------------
// Real editable timelines: text clips only, so they open in the Video
// Editor with no media file needed. The user drops their own clips in.
function videoIntro() {
  const t = blankTimeline('16:9', 30);
  const textTrack = t.tracks.find((tr) => tr.kind === 'text');
  const c1 = defaultClip('text', null, 0, 3);
  c1.name = 'Welcome title';
  c1.text = { ...c1.text, text: 'Welcome to My Channel', fontSize: 96, x: 50, y: 40, animIn: 'fade', animOut: 'fade' };
  const c2 = defaultClip('text', null, 3, 2);
  c2.name = 'Subtitle';
  c2.text = { ...c2.text, text: 'New videos every week', fontSize: 48, x: 50, y: 60, animIn: 'slide', animOut: 'fade' };
  textTrack.clips = [c1, c2];
  return t;
}

function videoQuizOpener() {
  const t = blankTimeline('9:16', 30);
  const textTrack = t.tracks.find((tr) => tr.kind === 'text');
  const c1 = defaultClip('text', null, 0, 2);
  c1.name = 'Quiz badge';
  c1.text = { ...c1.text, text: 'QUIZ TIME!', fontSize: 110, x: 50, y: 30, animIn: 'pop', animOut: 'fade' };
  const c2 = defaultClip('text', null, 2, 3);
  c2.name = 'Question prompt';
  c2.text = { ...c2.text, text: 'Can you answer all 5?', fontSize: 56, x: 50, y: 50, animIn: 'fade', animOut: 'fade' };
  textTrack.clips = [c1, c2];
  return t;
}

function videoOutro() {
  const t = blankTimeline('16:9', 30);
  const textTrack = t.tracks.find((tr) => tr.kind === 'text');
  const c1 = defaultClip('text', null, 0, 3);
  c1.name = 'Thanks';
  c1.text = { ...c1.text, text: 'Thanks for watching!', fontSize: 88, x: 50, y: 40, animIn: 'fade', animOut: 'fade' };
  const c2 = defaultClip('text', null, 3, 2);
  c2.name = 'Subscribe';
  c2.text = { ...c2.text, text: 'Like & Subscribe', fontSize: 64, x: 50, y: 60, animIn: 'slide', animOut: 'fade' };
  textTrack.clips = [c1, c2];
  return t;
}

// --- v2.2.4: deck templates --------------------------------------------------
// Real editable decks built from the app's own slide layouts. Texts are
// short by construction; deckFitCheck + uniform fonts are applied so no
// slide ever overflows.
function setSlideText(slide, role, text) {
  const el = (slide.elements || []).find((e) => e.type === 'text' && e.role === role);
  if (el) el.text.text = text;
  return slide;
}
function quizSlide(question, options, correctIndex) {
  const s = ds.blankSlide('quiz');
  setSlideText(s, 'question', question);
  const names = ['Option A', 'Option B', 'Option C', 'Option D'];
  (s.elements || []).forEach((e) => {
    if (e.type === 'text' && e.role === 'option') {
      const idx = names.indexOf(e.name);
      if (idx >= 0 && options[idx]) e.text.text = `${String.fromCharCode(65 + idx)}. ${options[idx]}`;
    }
    if (e.type === 'shape' && e.name && e.name.endsWith(' box')) {
      const idx = ['Option A box', 'Option B box', 'Option C box', 'Option D box'].indexOf(e.name);
      if (idx >= 0) e.shape.fill = idx === correctIndex ? '#16a34a' : '#24304f';
    }
  });
  return s;
}
function textSlide(title, body) {
  const s = ds.blankSlide('text');
  setSlideText(s, 'title', title);
  setSlideText(s, 'body', body);
  return s;
}
function finishDeck(deck) {
  const checked = ds.deckFitCheck(deck);
  if (!checked.ok) throw new Error('Built-in deck is invalid: ' + checked.errors.join(' '));
  if (checked.needsAttention.length) {
    throw new Error('Built-in deck has overflowing text: ' + checked.needsAttention.map((n) => n.layerId).join(', '));
  }
  return ds.applyDeckUniformFonts(deck).deck;
}

function deckPitch() {
  const deck = ds.blankDeck({ title: 'Startup Pitch' });
  const title = ds.blankSlide('title');
  setSlideText(title, 'title', 'Startup Pitch');
  setSlideText(title, 'subtitle', 'A one-line description of the idea');
  const chart = ds.blankSlide('chart');
  setSlideText(chart, 'title', 'Growth So Far');
  const chartEl = chart.elements.find((e) => e.type === 'chart');
  if (chartEl) chartEl.chart = { type: 'bar', title: '', legend: true, showValues: true, labels: ['2023', '2024', '2025', '2026'], datasets: [{ label: 'Users', values: [120, 480, 1900, 5200], color: '#7c5cff' }] };
  deck.slides = [
    title,
    textSlide('The Problem', '•  Small shops lose customers after one visit\n•  No cheap way to stay in touch\n•  Paper loyalty cards get lost'),
    textSlide('Our Solution', '•  A simple loyalty app for any shop\n•  Customers earn points automatically\n•  Owners see who comes back, and when'),
    chart,
    textSlide('The Ask', '•  Raising Rs. 5,000,000 seed\n•  18 months of runway\n•  Launch in 3 cities by Q3'),
  ];
  return finishDeck(deck);
}

function deckQuiz() {
  const deck = ds.blankDeck({ title: 'General Knowledge Quiz' });
  const title = ds.blankSlide('title');
  setSlideText(title, 'title', 'General Knowledge Quiz');
  setSlideText(title, 'subtitle', '5 questions · 3 seconds each · How many can you get?');
  deck.slides = [
    title,
    quizSlide('Which planet is known as the Red Planet?', ['Venus', 'Mars', 'Jupiter', 'Saturn'], 1),
    quizSlide('What is 9 × 8?', ['64', '72', '81', '56'], 1),
    quizSlide('Which ocean is the largest?', ['Atlantic', 'Indian', 'Arctic', 'Pacific'], 3),
    textSlide('Results', '•  3 out of 3 — Quiz champion!\n•  2 out of 3 — Well done!\n•  0–1 — Try again, you will get it!'),
  ];
  return finishDeck(deck);
}

function deckPortfolio() {
  const deck = ds.blankDeck({ title: 'Portfolio' });
  const title = ds.blankSlide('title');
  setSlideText(title, 'title', 'My Portfolio');
  setSlideText(title, 'subtitle', 'Design · Video · Content — selected work 2024–2026');
  const showcase = ds.blankSlide('text-image');
  setSlideText(showcase, 'title', 'Featured Project');
  setSlideText(showcase, 'body', 'A brand refresh for a local café:\nnew logo, menu design and a\nlaunch video — footfall up 30%.');
  deck.slides = [
    title,
    textSlide('What I Do', '•  Brand identity & logo design\n•  Social media graphics & video\n•  Presentations & pitch decks'),
    showcase,
    textSlide('Get In Touch', '•  hello@studio.com\n•  +92 300 0000000\n•  www.studio.com'),
  ];
  return finishDeck(deck);
}

function promoPost() {
  const d = blankDesign(1080, 1080);
  d.background = { type: 'gradient', color: '#7c5cff', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const badge = defaultShapeLayer('rect', 390, 90, 300, 64, { fill: '#ffffff', radius: 32, name: 'Badge' });
  const badgeText = defaultTextLayer(390, 98, 'LIMITED OFFER', { w: 300, h: 48, fontSize: 30, fontWeight: 800, color: '#7c5cff' });
  const headline = defaultTextLayer(90, 300, 'SUMMER\nSALE', { w: 900, h: 360, fontSize: 150, fontWeight: 800, color: '#ffffff', lineHeight: 1.0 });
  const sub = defaultTextLayer(190, 600, 'Up to 50% off everything', { w: 700, h: 60, fontSize: 40, fontWeight: 500, color: '#e8ecf8' });
  const cta = defaultShapeLayer('rect', 390, 720, 300, 88, { fill: '#ffffff', radius: 44, name: 'CTA button' });
  const ctaText = defaultTextLayer(390, 736, 'SHOP NOW', { w: 300, h: 56, fontSize: 36, fontWeight: 800, color: '#3b82f6' });
  const foot = defaultTextLayer(240, 880, 'www.yourshop.com', { w: 600, h: 44, fontSize: 28, fontWeight: 400, color: '#dbe2f5' });
  d.layers = [badge, badgeText, headline, sub, cta, ctaText, foot];
  return d;
}

function salePoster() {
  const d = blankDesign(1080, 1350);
  d.background = { type: 'color', color: '#111832', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const bar = defaultShapeLayer('rect', 0, 0, 1080, 18, { fill: '#f59e0b', radius: 0, name: 'Top bar' });
  const kicker = defaultTextLayer(90, 140, 'GRAND OPENING', { w: 900, h: 50, fontSize: 34, fontWeight: 700, color: '#f59e0b', letterSpacing: 6 });
  const headline = defaultTextLayer(90, 220, 'BIG SALE\nWEEKEND', { w: 900, h: 336, fontSize: 140, fontWeight: 800, color: '#ffffff', lineHeight: 1.05 });
  const offer = defaultShapeLayer('ellipse', 340, 560, 400, 400, { fill: '#ef4444', name: 'Offer circle' });
  const offerText = defaultTextLayer(340, 660, '50%\nOFF', { w: 400, h: 264, fontSize: 110, fontWeight: 800, color: '#ffffff', lineHeight: 1.0 });
  const detail = defaultTextLayer(140, 1010, 'Friday – Sunday · In store & online', { w: 800, h: 50, fontSize: 32, fontWeight: 400, color: '#93a0c4' });
  const cta = defaultShapeLayer('rect', 340, 1100, 400, 90, { fill: '#f59e0b', radius: 45, name: 'CTA button' });
  const ctaText = defaultTextLayer(340, 1118, 'VISIT US TODAY', { w: 400, h: 54, fontSize: 32, fontWeight: 800, color: '#111832' });
  d.layers = [bar, kicker, headline, offer, offerText, detail, cta, ctaText];
  return d;
}

function youtubeThumbnail() {
  const d = blankDesign(1280, 720);
  d.background = { type: 'gradient', color: '#0b1020', gradient: { from: '#1a2347', to: '#0b1020', angle: 120 } };
  const accent = defaultShapeLayer('rect', 0, 620, 1280, 100, { fill: '#ef4444', radius: 0, name: 'Bottom bar' });
  const headline = defaultTextLayer(70, 130, 'HOW I EDIT\nVIDEOS FAST', { w: 900, h: 264, fontSize: 110, fontWeight: 800, color: '#ffffff', align: 'left', lineHeight: 1.05 });
  const sub = defaultTextLayer(70, 420, 'My full workflow, step by step', { w: 800, h: 56, fontSize: 38, fontWeight: 500, color: '#22d3ee', align: 'left' });
  const badge = defaultShapeLayer('rect', 980, 80, 230, 90, { fill: '#f59e0b', radius: 16, name: 'Badge' });
  const badgeText = defaultTextLayer(980, 96, 'NEW!', { w: 230, h: 60, fontSize: 44, fontWeight: 800, color: '#111832' });
  const barText = defaultTextLayer(70, 640, 'WATCH NOW', { w: 400, h: 60, fontSize: 36, fontWeight: 800, color: '#ffffff', align: 'left' });
  d.layers = [accent, headline, sub, badge, badgeText, barText];
  return d;
}

function quotePost() {
  const d = blankDesign(1080, 1080);
  d.background = { type: 'color', color: '#f5f0e8', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const mark = defaultTextLayer(90, 120, '“', { w: 200, h: 264, fontSize: 220, fontWeight: 700, color: '#7c5cff', fontFamily: 'Playfair Display', align: 'left' });
  const quote = defaultTextLayer(140, 330, 'Creativity is\nintelligence\nhaving fun.', { w: 800, h: 360, fontSize: 84, fontWeight: 700, color: '#111832', fontFamily: 'Playfair Display', lineHeight: 1.15 });
  const rule = defaultShapeLayer('rect', 140, 740, 120, 8, { fill: '#7c5cff', radius: 4, name: 'Rule' });
  const author = defaultTextLayer(140, 780, '— Albert Einstein', { w: 800, h: 50, fontSize: 34, fontWeight: 500, color: '#6b78a3', align: 'left' });
  const handle = defaultTextLayer(140, 950, '@yourstudio', { w: 800, h: 44, fontSize: 28, fontWeight: 400, color: '#93a0c4', align: 'left' });
  d.layers = [mark, quote, rule, author, handle];
  return d;
}

function businessCard() {
  const d = blankDesign(1050, 600);
  d.background = { type: 'color', color: '#0b1020', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const side = defaultShapeLayer('rect', 0, 0, 14, 600, { fill: '#22d3ee', radius: 0, name: 'Side bar' });
  const name = defaultTextLayer(70, 130, 'Alison Ahmed', { w: 600, h: 80, fontSize: 64, fontWeight: 800, color: '#ffffff', align: 'left' });
  const role = defaultTextLayer(70, 220, 'Creative Director', { w: 600, h: 50, fontSize: 32, fontWeight: 500, color: '#22d3ee', align: 'left' });
  const contact = defaultTextLayer(70, 330, 'hello@studio.com  ·  +92 300 0000000\nwww.studio.com', { w: 600, h: 100, fontSize: 28, fontWeight: 400, color: '#93a0c4', align: 'left', lineHeight: 1.5 });
  const logo = defaultShapeLayer('ellipse', 830, 180, 150, 150, { fill: '#7c5cff', name: 'Logo mark' });
  const logoText = defaultTextLayer(830, 215, 'CS', { w: 150, h: 90, fontSize: 64, fontWeight: 800, color: '#ffffff' });
  d.layers = [side, name, role, contact, logo, logoText];
  return d;
}

function flyer() {
  const d = blankDesign(1240, 1754);
  d.background = { type: 'color', color: '#ffffff', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const header = defaultShapeLayer('rect', 0, 0, 1240, 420, { fill: '#7c5cff', radius: 0, name: 'Header' });
  const kicker = defaultTextLayer(90, 90, 'FREE WORKSHOP', { w: 1060, h: 50, fontSize: 34, fontWeight: 700, color: '#ffffff', align: 'left', letterSpacing: 4 });
  const headline = defaultTextLayer(90, 160, 'Design Like\na Pro', { w: 1060, h: 288, fontSize: 120, fontWeight: 800, color: '#ffffff', align: 'left', lineHeight: 1.05 });
  const body = defaultTextLayer(90, 520, 'Join our hands-on workshop and learn\nthe tools, workflows and shortcuts\nprofessional designers use every day.', { w: 1060, h: 200, fontSize: 40, fontWeight: 400, color: '#1a2347', align: 'left', lineHeight: 1.4 });
  const date = defaultShapeLayer('rect', 90, 800, 520, 120, { fill: '#f5f0e8', radius: 16, name: 'Date box' });
  const dateText = defaultTextLayer(90, 820, 'SAT · 22 NOV', { w: 520, h: 80, fontSize: 40, fontWeight: 800, color: '#111832' });
  const time = defaultShapeLayer('rect', 640, 800, 510, 120, { fill: '#f5f0e8', radius: 16, name: 'Time box' });
  const timeText = defaultTextLayer(640, 820, '10:00 AM', { w: 510, h: 80, fontSize: 40, fontWeight: 800, color: '#111832' });
  const cta = defaultShapeLayer('rect', 90, 1000, 1060, 110, { fill: '#111832', radius: 55, name: 'CTA button' });
  const ctaText = defaultTextLayer(90, 1022, 'RESERVE YOUR SEAT — FREE', { w: 1060, h: 66, fontSize: 38, fontWeight: 800, color: '#ffffff' });
  const foot = defaultTextLayer(90, 1560, 'CreativeStudio · www.studio.com', { w: 1060, h: 50, fontSize: 30, fontWeight: 400, color: '#93a0c4' });
  d.layers = [header, kicker, headline, body, date, dateText, time, timeText, cta, ctaText, foot];
  return d;
}

function story() {
  const d = blankDesign(1080, 1920);
  d.background = { type: 'gradient', color: '#7c5cff', gradient: { from: '#7c5cff', to: '#22d3ee', angle: 160 } };
  const pill = defaultShapeLayer('rect', 340, 180, 400, 70, { fill: '#ffffff', radius: 35, name: 'Pill' });
  const pillText = defaultTextLayer(340, 190, 'NEW DROP', { w: 400, h: 50, fontSize: 32, fontWeight: 800, color: '#7c5cff' });
  const headline = defaultTextLayer(80, 700, 'Fresh\nStyles\nAre Here', { w: 920, h: 540, fontSize: 150, fontWeight: 800, color: '#ffffff', lineHeight: 1.05 });
  const sub = defaultTextLayer(140, 1280, 'Swipe up to shop the collection', { w: 800, h: 60, fontSize: 36, fontWeight: 500, color: '#e8ecf8' });
  const arrow = defaultTextLayer(490, 1400, '↑', { w: 100, h: 100, fontSize: 72, fontWeight: 700, color: '#ffffff' });
  const swipe = defaultShapeLayer('rect', 440, 1620, 200, 10, { fill: '#ffffff', radius: 5, name: 'Swipe bar' });
  d.layers = [pill, pillText, headline, sub, arrow, swipe];
  return d;
}

function presentationSlide() {
  const d = blankDesign(1920, 1080);
  d.background = { type: 'color', color: '#0b1020', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const accent = defaultShapeLayer('rect', 0, 0, 24, 1080, { fill: '#22d3ee', radius: 0, name: 'Side bar' });
  const kicker = defaultTextLayer(160, 150, 'Q4 RESULTS', { w: 1000, h: 50, fontSize: 36, fontWeight: 700, color: '#22d3ee', align: 'left', letterSpacing: 5 });
  const headline = defaultTextLayer(160, 230, 'Growth that\nspeaks for itself', { w: 1160, h: 264, fontSize: 110, fontWeight: 800, color: '#ffffff', align: 'left', lineHeight: 1.08 });
  const body = defaultTextLayer(160, 540, 'Revenue up 42% year over year, with\n2.4× more active creators on the platform.', { w: 1000, h: 130, fontSize: 38, fontWeight: 400, color: '#93a0c4', align: 'left', lineHeight: 1.4 });
  const stat1 = defaultShapeLayer('rect', 160, 760, 420, 180, { fill: '#151d3a', radius: 20, name: 'Stat card 1' });
  const stat1Text = defaultTextLayer(160, 790, '+42%', { w: 420, h: 90, fontSize: 72, fontWeight: 800, color: '#22d3ee' });
  const stat1Label = defaultTextLayer(160, 880, 'Revenue', { w: 420, h: 44, fontSize: 28, fontWeight: 500, color: '#93a0c4' });
  const stat2 = defaultShapeLayer('rect', 620, 760, 420, 180, { fill: '#151d3a', radius: 20, name: 'Stat card 2' });
  const stat2Text = defaultTextLayer(620, 790, '2.4×', { w: 420, h: 90, fontSize: 72, fontWeight: 800, color: '#7c5cff' });
  const stat2Label = defaultTextLayer(620, 880, 'Creators', { w: 420, h: 44, fontSize: 28, fontWeight: 500, color: '#93a0c4' });
  const page = defaultTextLayer(1700, 980, '04 / 12', { w: 160, h: 44, fontSize: 28, fontWeight: 500, color: '#6b78a3' });
  d.layers = [accent, kicker, headline, body, stat1, stat1Text, stat1Label, stat2, stat2Text, stat2Label, page];
  return d;
}

const BUILTIN_TEMPLATES = [
  { id: 'builtin-promo-post', name: 'Instagram Promo Post', category: 'Social', size: 'Instagram Post', kind: 'design', builtin: true, build: promoPost },
  { id: 'builtin-sale-poster', name: 'Sale Poster', category: 'Promo', size: 'Poster', kind: 'design', builtin: true, build: salePoster },
  { id: 'builtin-youtube-thumbnail', name: 'YouTube Thumbnail', category: 'Video', size: 'YouTube Thumbnail', kind: 'design', builtin: true, build: youtubeThumbnail },
  { id: 'builtin-quote-post', name: 'Quote Post', category: 'Social', size: 'Instagram Post', kind: 'design', builtin: true, build: quotePost },
  { id: 'builtin-business-card', name: 'Business Card', category: 'Business', size: 'Business Card', kind: 'design', builtin: true, build: businessCard },
  { id: 'builtin-flyer', name: 'Workshop Flyer', category: 'Print', size: 'Flyer (A4)', kind: 'design', builtin: true, build: flyer },
  { id: 'builtin-story', name: 'Story Announcement', category: 'Social', size: 'Instagram Story', kind: 'design', builtin: true, build: story },
  { id: 'builtin-presentation', name: 'Results Slide', category: 'Business', size: 'Presentation Slide', kind: 'design', builtin: true, build: presentationSlide },
  // v2.2.4 — design (12 more; 20 design templates in total)
  { id: 'builtin-eid-post', name: 'Eid Mubarak Post', category: 'Social', size: 'Instagram Post', kind: 'design', builtin: true, build: eidPost },
  { id: 'builtin-product-launch', name: 'Product Launch', category: 'Promo', size: 'Instagram Post', kind: 'design', builtin: true, build: productLaunch },
  { id: 'builtin-food-promo', name: 'Food Deal Promo', category: 'Promo', size: 'Instagram Post', kind: 'design', builtin: true, build: foodPromo },
  { id: 'builtin-real-estate', name: 'Property For Sale', category: 'Business', size: 'Instagram Post', kind: 'design', builtin: true, build: realEstate },
  { id: 'builtin-fitness-challenge', name: '30-Day Fitness Challenge', category: 'Promo', size: 'Poster', kind: 'design', builtin: true, build: fitnessChallenge },
  { id: 'builtin-wedding-invite', name: 'Wedding Invitation', category: 'Print', size: 'Poster', kind: 'design', builtin: true, build: weddingInvite },
  { id: 'builtin-concert-poster', name: 'Concert Poster', category: 'Promo', size: 'Poster', kind: 'design', builtin: true, build: concertPoster },
  { id: 'builtin-linkedin-banner', name: 'LinkedIn Banner', category: 'Business', size: 'LinkedIn Banner', kind: 'design', builtin: true, build: linkedinBanner },
  { id: 'builtin-sale-banner-wide', name: 'Flash Sale Banner (wide)', category: 'Promo', size: 'Wide Banner', kind: 'design', builtin: true, build: saleBannerWide },
  { id: 'builtin-motivational-2', name: 'Motivational Quote 2', category: 'Social', size: 'Instagram Post', kind: 'design', builtin: true, build: motivational2 },
  { id: 'builtin-price-list', name: 'Menu / Price List', category: 'Business', size: 'Poster', kind: 'design', builtin: true, build: priceList },
  { id: 'builtin-app-promo-story', name: 'App Promo Story', category: 'Social', size: 'Instagram Story', kind: 'design', builtin: true, build: appPromoStory },
  // v2.2.4 — video (real editable timelines; text clips only, no media needed)
  { id: 'builtin-video-intro', name: 'Channel Intro (16:9)', category: 'Video', size: 'Video 16:9', kind: 'video', builtin: true, build: videoIntro },
  { id: 'builtin-video-quiz-opener', name: 'Quiz Opener (9:16)', category: 'Video', size: 'Video 9:16', kind: 'video', builtin: true, build: videoQuizOpener },
  { id: 'builtin-video-outro', name: 'Video Outro (16:9)', category: 'Video', size: 'Video 16:9', kind: 'video', builtin: true, build: videoOutro },
  // v2.2.4 — decks (real editable decks; fit-checked, uniform quiz fonts)
  { id: 'builtin-deck-pitch', name: 'Startup Pitch Deck', category: 'Business', size: 'Presentation', kind: 'deck', builtin: true, build: deckPitch },
  { id: 'builtin-deck-quiz', name: 'General Knowledge Quiz Deck', category: 'Education', size: 'Presentation', kind: 'deck', builtin: true, build: deckQuiz },
  { id: 'builtin-deck-portfolio', name: 'Portfolio Deck', category: 'Business', size: 'Presentation', kind: 'deck', builtin: true, build: deckPortfolio },
];

function builtinTemplate(id) {
  const t = BUILTIN_TEMPLATES.find((x) => x.id === id);
  if (!t) return null;
  const content = t.build();
  const out = { id: t.id, name: t.name, category: t.category, size: t.size, kind: t.kind, builtin: true, content, width: content.width, height: content.height };
  // Backward compatible: design templates also carry `design` (the Graphic
  // Editor and the design routes read t.design).
  if (t.kind === 'design') out.design = content;
  return out;
}
function listBuiltinTemplates(kind) {
  const list = kind ? BUILTIN_TEMPLATES.filter((t) => t.kind === kind) : BUILTIN_TEMPLATES;
  return list.map((t) => {
    const content = t.build();
    const out = { id: t.id, name: t.name, category: t.category, size: t.size, kind: t.kind, builtin: true, width: content.width, height: content.height, content };
    if (t.kind === 'design') out.design = content;
    return out;
  });
}

module.exports = { BUILTIN_TEMPLATES, builtinTemplate, listBuiltinTemplates };
