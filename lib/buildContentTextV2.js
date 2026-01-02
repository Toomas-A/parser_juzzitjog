const { extractSectionHtmlBlocks } = require("./extractSections.js");
const { htmlToTextPreserveBlocks } = require("./htmlToText.js");

/**
 * Builds a section-aware plain text from Mercury content HTML.
 * This avoids regex truncation on nested <div>.
 */
function buildContentTextV2(contentHtml) {
  const blocks = extractSectionHtmlBlocks(contentHtml);

  const texts = blocks
    .map((b) => htmlToTextPreserveBlocks(b))
    .map((t) => (t || "").trim())
    .filter(Boolean);

  return texts.join("\n\n");
}

module.exports = { buildContentTextV2 };
