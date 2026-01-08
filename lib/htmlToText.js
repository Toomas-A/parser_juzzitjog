const { htmlToText } = require("html-to-text");

/**
 * Converts HTML to readable text while preserving block separation.
 */
function htmlToTextPreserveBlocks(html) {
  return htmlToText(html, {
    wordwrap: false,
    preserveNewlines: true,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "svg", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "iframe", format: "skip" },
    ],
  });
}

module.exports = { htmlToTextPreserveBlocks };
