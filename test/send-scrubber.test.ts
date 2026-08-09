/// <reference types="node" />
import test from "node:test";
import assert from "node:assert";
import {
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

test("HTML scrubbing removes only the Thundervim status node", () => {
  const body =
    '<div><strong>Hello</strong><br>there</div><div id="thundervim-status">status</div>';
  const cleaned = "<div><strong>Hello</strong><br>there</div>";
  let removed = false;
  const parser: HtmlParser = {
    parseFromString() {
      return {
        body: {
          get innerHTML() {
            return removed ? cleaned : body;
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
});
