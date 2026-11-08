import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

export async function scrapeImages(pageUrl, outputDir = 'chapter_images') {
  const parsedPageUrl = new URL(pageUrl);
  if (!['http:', 'https:'].includes(parsedPageUrl.protocol)) {
    throw new Error('URL must use http or https.');
  }

  const pageAddress = parsedPageUrl.href;
  const resolvedOutputDir = path.resolve(outputDir);
  await fs.mkdir(resolvedOutputDir, { recursive: true });

  const headers = {
    'User-Agent': 'Mozilla/5.0 (authorized personal archive)',
  };

  const response = await fetch(pageAddress, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}: ${pageAddress}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  let pageTitle = $('title').text().trim();
  if (!pageTitle) {
    pageTitle = parsedPageUrl.pathname.replace(/\/+$/, '').split('/').filter(Boolean).at(-1) || 'page';
  }

  const safeTitle = pageTitle
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/^\.+|\.+$/g, '') || 'page';

  const seen = new Set();
  const imageUrls = [];

  $('img').each((_, element) => {
    const img = $(element);
    const candidate =
      img.attr('src') ||
      img.attr('data-src') ||
      img.attr('data-lazy-src') ||
      (() => {
        const srcset = img.attr('srcset');
        if (!srcset) return null;
        const first = srcset.split(',')[0]?.trim();
        return first?.split(/\s+/)[0] || null;
      })();

    if (!candidate) return;

    const absoluteUrl = new URL(candidate, pageAddress).toString();
    if (!seen.has(absoluteUrl)) {
      seen.add(absoluteUrl);
      imageUrls.push(absoluteUrl);
    }
  });

  for (let index = 0; index < imageUrls.length; index += 1) {
    const imageUrl = imageUrls[index];
    const imageResponse = await fetch(imageUrl, { headers, signal: AbortSignal.timeout(30000) });
    if (!imageResponse.ok) {
      throw new Error(`Image request failed with status ${imageResponse.status}: ${imageUrl}`);
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const parsedUrl = new URL(imageUrl);
    const suffix = path.extname(parsedUrl.pathname) || '.jpg';
    const filename = `${safeTitle}_${String(index + 1).padStart(3, '0')}${suffix}`;

    await fs.writeFile(path.join(resolvedOutputDir, filename), imageBuffer);
    console.log(`Saved ${index + 1}: ${imageUrl}`);
  }
}
