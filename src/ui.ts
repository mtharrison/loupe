import { BRAND_NAME, renderBrandMarkSvg } from './brand';
import { renderThemeBootstrapScript } from './theme';

export function renderAppHtml(): string {
  const brandIcon = renderBrandMarkSvg();
  const faviconHref = `data:image/svg+xml,${encodeURIComponent(brandIcon)}`;
  const themeBootstrapScript = renderThemeBootstrapScript();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${BRAND_NAME}</title>
    <link rel="icon" href="${faviconHref}" />
    <script>${themeBootstrapScript}</script>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;
}
