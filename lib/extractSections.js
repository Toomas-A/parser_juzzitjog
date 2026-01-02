const cheerio = require("cheerio");

/**
 * Robustly extracts "section blocks" from Mercury's result.content HTML.
 * Avoids regex truncation on nested <div>.
 */
function extractSectionHtmlBlocks(contentHtml) {
  if (!contentHtml || typeof contentHtml !== "string") return [];

  const $ = cheerio.load(contentHtml);

  // Prefer explicit section wrappers if present
  const sectionDivs = $('div[id^="section-"]');

  if (sectionDivs.length > 0) {
    return sectionDivs
      .map((_, el) => $.html(el))
      .get()
      .filter(Boolean);
  }

  // Fallback: return whole content as one block
  return [contentHtml];
}

/**
 * Optional helper: for card layouts like BelieveInTheRun "What You Need To Know"
 * where specs are split into columns.
 */
function extractSingleColBlocks(contentHtml) {
  if (!contentHtml || typeof contentHtml !== "string") return [];

  const $ = cheerio.load(contentHtml);
  const cols = $(".wysiwyg-columns .single-col");

  if (cols.length === 0) return [];

  return cols.map((_, el) => $.html(el)).get().filter(Boolean);
}

module.exports = {
  extractSectionHtmlBlocks,
  extractSingleColBlocks,
};
