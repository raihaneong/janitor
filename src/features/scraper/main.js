import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

export async function scrapeImages(pageUrl, outputDir = 'chapter_images'  ) {
  const parsedPageUrl = new URL(pageUrl);
  if (!['http:', 'https:'].includes(parsedPageUrl.protocol)) {
    throw new Error('URL must use http or https.');
  }

  const chapterMatch = parsedPageUrl.pathname.match(/chapter[-_/]?(\d+(?:\.\d+)?)/i);
  if (!chapterMatch) {
    throw new Error('Could not find a chapter number in the URL path.');
  }
  const chapterNumber = chapterMatch[1];
  const pageAddress = parsedPageUrl.href;
  const resolvedOutputDir = path.resolve(outputDir);

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

  const titleWithoutChapter = pageTitle.replace(/chapter[-_\s]*\d+(?:\.\d+)?/i, '');
  const safeTitle = titleWithoutChapter
    .toLowerCase()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'page';

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

  const chapterDir = path.join(
    resolvedOutputDir,
    parsedPageUrl.hostname,
    `chapter-${chapterNumber}`
  );
  await fs.mkdir(chapterDir, { recursive: true });

  for (let index = 0; index < imageUrls.length; index += 1) {
    const imageUrl = imageUrls[index];
    const imageResponse = await fetch(imageUrl, { headers, signal: AbortSignal.timeout(30000) });
    if (!imageResponse.ok) {
      throw new Error(`Image request failed with status ${imageResponse.status}: ${imageUrl}`);
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const parsedUrl = new URL(imageUrl);
    const suffix = path.extname(parsedUrl.pathname) || '.jpg';
    const pageNumber = String(index + 1).padStart(3, '0');
    const filename = `${safeTitle}_ch${chapterNumber}_p${pageNumber}${suffix}`;

    await fs.writeFile(path.join(chapterDir, filename), imageBuffer);
    console.log(`Saved ${index + 1}: ${imageUrl}`);
  }
}
