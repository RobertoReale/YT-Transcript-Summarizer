import puppeteer from 'puppeteer';
import path from 'path';

(async () => {
  const extensionPath = path.resolve('..');
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-size=1280,800'
    ]
  });

  const page = await browser.newPage();
  console.log('Navigating to YouTube video...');
  try {
    await page.goto('https://www.youtube.com/watch?v=M7FIvfx5J10', { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) {
    console.log('Navigation took too long, proceeding anyway...');
  }
  
  // Wait a bit for page load
  await new Promise(r => setTimeout(r, 5000));
  
  // Try to find the extension ID to open its sidepanel/popup
  // This is tricky because the ID is dynamic when loaded unpacked.
  const targets = await browser.targets();
  const backgroundTarget = targets.find(t => t.type() === 'service_worker' || t.url().includes('chrome-extension://'));
  
  if (backgroundTarget) {
    const extensionId = backgroundTarget.url().split('/')[2];
    console.log('Extension ID:', extensionId);
    
    // Open the sidepanel
    const extPage = await browser.newPage();
    await extPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    console.log('Sidepanel opened.');
    
    // Take screenshot of sidepanel
    await extPage.screenshot({ path: 'sidepanel-initial.png' });
    console.log('Saved sidepanel-initial.png');
    
    // Try to click settings
    await extPage.click('#btn-settings');
    await new Promise(r => setTimeout(r, 1000));
    await extPage.screenshot({ path: 'sidepanel-settings.png' });
    console.log('Saved sidepanel-settings.png');
    
    // Close modal
    await extPage.click('#btn-close-modal');
    await new Promise(r => setTimeout(r, 1000));
    
    // Try to summarize (it will likely ask for API key or fail, which is fine)
    await extPage.click('#btn-summarize');
    await new Promise(r => setTimeout(r, 2000));
    await extPage.screenshot({ path: 'sidepanel-summarize.png' });
    console.log('Saved sidepanel-summarize.png');
    
  } else {
    console.log('Could not find extension target.');
  }

  await browser.close();
})();
