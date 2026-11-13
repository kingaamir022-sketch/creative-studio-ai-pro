'use strict';
// Built-in starter templates (Phase 2). Each template is a REAL editable
// design: layers, not a flattened image. The editor loads the template's
// design JSON into a project, where every layer stays editable.
const { blankDesign, defaultTextLayer, defaultShapeLayer } = require('./design-model');

function promoPost() {
  const d = blankDesign(1080, 1080);
  d.background = { type: 'gradient', color: '#7c5cff', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const badge = defaultShapeLayer('rect', 390, 90, 300, 64, { fill: '#ffffff', radius: 32, name: 'Badge' });
  const badgeText = defaultTextLayer(390, 98, 'LIMITED OFFER', { w: 300, h: 48, fontSize: 30, fontWeight: 800, color: '#7c5cff' });
  const headline = defaultTextLayer(90, 300, 'SUMMER\nSALE', { w: 900, h: 280, fontSize: 150, fontWeight: 800, color: '#ffffff', lineHeight: 1.0 });
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
  const headline = defaultTextLayer(90, 220, 'BIG SALE\nWEEKEND', { w: 900, h: 300, fontSize: 140, fontWeight: 800, color: '#ffffff', lineHeight: 1.05 });
  const offer = defaultShapeLayer('ellipse', 340, 560, 400, 400, { fill: '#ef4444', name: 'Offer circle' });
  const offerText = defaultTextLayer(340, 660, '50%\nOFF', { w: 400, h: 220, fontSize: 110, fontWeight: 800, color: '#ffffff', lineHeight: 1.0 });
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
  const headline = defaultTextLayer(70, 130, 'HOW I EDIT\nVIDEOS FAST', { w: 900, h: 260, fontSize: 110, fontWeight: 800, color: '#ffffff', align: 'left', lineHeight: 1.05 });
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
  const mark = defaultTextLayer(90, 120, '“', { w: 200, h: 200, fontSize: 220, fontWeight: 700, color: '#7c5cff', fontFamily: 'Playfair Display', align: 'left' });
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
  const headline = defaultTextLayer(90, 160, 'Design Like\na Pro', { w: 1060, h: 220, fontSize: 120, fontWeight: 800, color: '#ffffff', align: 'left', lineHeight: 1.05 });
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
  const headline = defaultTextLayer(160, 230, 'Growth that\nspeaks for itself', { w: 1100, h: 260, fontSize: 110, fontWeight: 800, color: '#ffffff', align: 'left', lineHeight: 1.08 });
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
  { id: 'builtin-promo-post', name: 'Instagram Promo Post', category: 'Social', size: 'Instagram Post', builtin: true, build: promoPost },
  { id: 'builtin-sale-poster', name: 'Sale Poster', category: 'Promo', size: 'Poster', builtin: true, build: salePoster },
  { id: 'builtin-youtube-thumbnail', name: 'YouTube Thumbnail', category: 'Video', size: 'YouTube Thumbnail', builtin: true, build: youtubeThumbnail },
  { id: 'builtin-quote-post', name: 'Quote Post', category: 'Social', size: 'Instagram Post', builtin: true, build: quotePost },
  { id: 'builtin-business-card', name: 'Business Card', category: 'Business', size: 'Business Card', builtin: true, build: businessCard },
  { id: 'builtin-flyer', name: 'Workshop Flyer', category: 'Print', size: 'Flyer (A4)', builtin: true, build: flyer },
  { id: 'builtin-story', name: 'Story Announcement', category: 'Social', size: 'Instagram Story', builtin: true, build: story },
  { id: 'builtin-presentation', name: 'Results Slide', category: 'Business', size: 'Presentation Slide', builtin: true, build: presentationSlide },
];

function builtinTemplate(id) {
  const t = BUILTIN_TEMPLATES.find((x) => x.id === id);
  if (!t) return null;
  return { id: t.id, name: t.name, category: t.category, size: t.size, builtin: true, design: t.build() };
}
function listBuiltinTemplates() {
  return BUILTIN_TEMPLATES.map((t) => {
    const design = t.build();
    return { id: t.id, name: t.name, category: t.category, size: t.size, builtin: true, width: design.width, height: design.height, design };
  });
}

module.exports = { BUILTIN_TEMPLATES, builtinTemplate, listBuiltinTemplates };
