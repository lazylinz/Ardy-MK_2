const { test, expect } = require("@playwright/test");

const PASSWORD = process.env.PASSWORD || "changeme";
const MOBILE_VIEWPORTS = [
  { name: "360x800", width: 360, height: 800 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "800x360-landscape", width: 800, height: 360 },
];

async function authenticate(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  if (page.url().includes("/chat.html")) return;

  await expect(page.locator("#password")).toBeVisible();
  await page.fill("#password", PASSWORD);
  await page.click("#loginBtn");
  await page.waitForURL("**/chat.html", { timeout: 15_000 });
}

async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - window.innerWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

for (const viewport of MOBILE_VIEWPORTS) {
  test.describe(`mobile smoke @ ${viewport.name}`, () => {
    test.use({ viewport });

    test.beforeEach(async ({ page }) => {
      await authenticate(page);
    });

    test("control page drawer, routing, and frame visibility", async ({ page }) => {
      await page.goto("/control.html", { waitUntil: "domcontentloaded" });

      const toggle = page.locator("[data-nav-toggle]");
      await expect(toggle).toBeVisible();

      await toggle.click();
      await expect(page.locator("body")).toHaveClass(/nav-open/);
      await page.click('[data-nav-backdrop]', { force: true });
      await expect(page.locator("body")).not.toHaveClass(/nav-open/);

      await toggle.click();
      await page.click('#primary-nav a[href="/macros.html"]');
      await page.waitForURL("**/macros.html");

      await page.goto("/control.html", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#cloud-gate")).toBeVisible();
      await expect(page.locator("#arduino-cloud-frame")).toBeVisible();
      await assertNoHorizontalOverflow(page);
    });

    test("macros page form usability and overflow safety", async ({ page }) => {
      await page.goto("/macros.html", { waitUntil: "domcontentloaded" });

      await expect(page.locator("#macro-form")).toBeVisible();
      await expect(page.getByRole("button", { name: "Save Macro" })).toBeVisible();

      const toggle = page.locator("[data-nav-toggle]");
      await toggle.click();
      await expect(page.locator("body")).toHaveClass(/nav-open/);
      await page.keyboard.press("Escape");
      await expect(page.locator("body")).not.toHaveClass(/nav-open/);

      await assertNoHorizontalOverflow(page);
      await expect(page.locator("#macro-list")).toBeVisible();
    });

    test("camera page toolbar reachability and feed container visibility", async ({ page }) => {
      await page.goto("/camera.html", { waitUntil: "domcontentloaded" });

      await expect(page.locator(".toolbar")).toBeVisible();
      await expect(page.locator("#mode-mjpeg")).toBeVisible();
      await expect(page.locator("#mode-snapshot")).toBeVisible();
      await expect(page.locator("#refresh-btn")).toBeVisible();
      await expect(page.locator(".frame-wrap")).toBeVisible();

      const bodyOverflowY = await page.evaluate(() => getComputedStyle(document.body).overflowY);
      expect(bodyOverflowY).not.toBe("hidden");
      await assertNoHorizontalOverflow(page);
    });
  });
}

test.describe("desktop sanity", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test("sidebar stays visible and mobile drawer controls stay hidden", async ({ page }) => {
    for (const path of ["/control.html", "/macros.html", "/camera.html"]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.locator(".sidebar")).toBeVisible();
      await expect(page.locator("[data-nav-toggle]")).toBeHidden();
      await assertNoHorizontalOverflow(page);
    }
  });
});
