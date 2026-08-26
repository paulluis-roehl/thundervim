/// <reference types="node" />
import test from "node:test";
import assert from "node:assert";
import {
  scrubDetails,
  scrubHtmlBody,
  scrubPlainTextBody,
  type HtmlParser,
} from "../src/send-scrubber.ts";

const STATUS_MARKER = "\u2063\u200c\u200d\u2063";

test("plain-text scrubbing preserves a URL on the final line", () => {
  const body = [
    "Best",
    "Example Sender",
    "",
    "---",
    "Example Project: A short description",
    "Calendar: https://cal.example.com/meeting",
    "Website: https://www.example.com/",
  ].join("\n");

  assert.strictEqual(scrubPlainTextBody(body), body);
});

test("plain-text scrubbing preserves wrapped quoted replies", () => {
  const body = [
    "Thanks for your message.",
    "",
    "On 1 January, Example Sender wrote:",
    "> This is the first quoted paragraph, wrapped across multiple",
    "> lines as it appeared in the compose window.",
    ">",
    "> This is another quoted paragraph with a link:",
    "> https://www.example.com/article",
    ">",
    "> Best",
  ].join("\r\n");
  const outgoing = `${body}\r\n${STATUS_MARKER}-- INSERT --${STATUS_MARKER}1,1 All`;

  assert.strictEqual(scrubPlainTextBody(outgoing), body);
});

test("plain-text details never rewrite Thunderbird's HTML mirror", () => {
  const plainTextBody = [
    "Thanks for your message.",
    "",
    "On 1 January, Example Sender wrote:",
    "> First quoted line",
    "> Second quoted line",
  ].join("\r\n");
  const details = {
    isPlainText: true,
    plainTextBody: `${plainTextBody}\r\n${STATUS_MARKER}-- NORMAL --`,
    body: [
      "<div>Thanks for your message.</div>",
      '<blockquote type="cite"><div>First quoted line</div>',
      "<div>Second quoted line</div></blockquote>",
      '<div id="thundervim-status">status</div>',
    ].join(""),
  };

  assert.deepStrictEqual(scrubDetails(details), {
    isPlainText: true,
    plainTextBody,
  });
});

test("plain-text scrubbing removes a legacy status only as a complete final line", () => {
  assert.strictEqual(
    scrubPlainTextBody("Message with https://example.com/path\n-- NORMAL --  1,8  Bot"),
    "Message with https://example.com/path",
  );
  assert.strictEqual(
    scrubPlainTextBody("Message with https://example.com/path\n/search"),
    "Message with https://example.com/path",
  );
});

test("marked status scrubbing never removes preceding message text", () => {
  assert.strictEqual(
    scrubPlainTextBody(`Keep this${STATUS_MARKER}-- INSERT --${STATUS_MARKER}1,1 All`),
    "Keep this",
  );
});

test("HTML without Thundervim nodes is returned unchanged", () => {
  const body =
    "<div>Hello</div><div>Website: <a href=\"https://example.com\">https://example.com</a></div>";
  let readTextContent = false;
  const parser: HtmlParser = {
    parseFromString() {
      return {
        body: {
          innerHTML: body,
          get textContent() {
            readTextContent = true;
            return "HelloWebsite: https://example.com";
          },
        },
        getElementById() {
          return null;
        },
      };
    },
  };

  assert.strictEqual(scrubHtmlBody(body, parser), body);
  assert.strictEqual(readTextContent, false);
});

test("HTML scrubbing preserves quoted reply structure", () => {
  const cleaned = [
    "<div>Thanks for your message.</div>",
    '<div class="moz-cite-prefix">On 1 January, Example Sender wrote:</div>',
    '<blockquote type="cite">',
    "<div>First quoted line</div>",
    "<div>Second quoted line</div>",
    "<br>",
    "<div>Another quoted paragraph</div>",
    "</blockquote>",
  ].join("");
  const body = `${cleaned}<div id="thundervim-status">status</div>`;
  let removed = false;
  let readTextContent = false;
  const parser: HtmlParser = {
    parseFromString() {
      return {
        body: {
          get innerHTML() {
            return removed ? cleaned : body;
          },
          get textContent() {
            readTextContent = true;
            return [
              "Thanks for your message.",
              "On 1 January, Example Sender wrote:",
              "First quoted lineSecond quoted lineAnother quoted paragraph",
            ].join("");
          },
        },
        getElementById(id) {
          if (id !== "thundervim-status" || removed) return null;
          return {
            remove() {
              removed = true;
            },
          };
        },
      };
    },
  };

  assert.strictEqual(scrubHtmlBody(body, parser), cleaned);
  assert.strictEqual(removed, true);
  assert.strictEqual(readTextContent, false);
});
