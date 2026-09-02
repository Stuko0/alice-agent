import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Alice Agent',
  tagline: 'The self-improving AI agent',
  favicon: 'img/favicon.ico',

  url: 'https://alice-agent.stuko.dev',
  baseUrl: '/docs/',

  organizationName: 'Stuko',
  projectName: 'alice-agent',

  onBrokenLinks: 'warn',
  scripts: [
    '/structured-data.js',
  ],
  headTags: [
    {
      tagName: 'link',
      attributes: {
        rel: 'manifest',
        href: '/docs/site.webmanifest',
      },
    },
    {
      tagName: 'meta',
      attributes: {
        name: 'theme-color',
        content: '#f0c040',
      },
    },
  ],
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh-Hans'],
    localeConfigs: {
      en: {
        label: 'English',
      },
      'zh-Hans': {
        label: '简体中文',
        htmlLang: 'zh-Hans',
      },
    },
  },

  themes: [
    '@docusaurus/theme-mermaid',
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      /** @type {import("@easyops-cn/docusaurus-search-local").PluginOptions} */
      ({
        hashed: true,
        language: ['en', 'zh'],
        indexBlog: false,
        docsRouteBasePath: '/',
        // Disabled: appends ?_highlight=... to URLs (before the #anchor),
        // which makes copy/pasted doc links ugly. Ctrl+F on the page is fine.
        highlightSearchTermsOnTargetPage: false,
        // Exclude the auto-generated per-skill catalog pages from search.
        // There are hundreds of them and they dominate results for generic
        // terms, drowning out the real user-guide / reference docs.
        // The two human-written catalog indexes (reference/skills-catalog,
        // reference/optional-skills-catalog) remain indexed.
        //
        // Note: ignoreFiles matches `route` (baseUrl stripped, no leading
        // slash). With baseUrl '/docs/', `/docs/user-guide/skills/bundled/x`
        // becomes 'user-guide/skills/bundled/x'.
        ignoreFiles: [
          /^user-guide\/skills\/bundled\//,
          /^user-guide\/skills\/optional\//,
        ],
      }),
    ],
  ],

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        // Static-host redirects for renamed doc pages (GitHub Pages can't
        // do server-side redirects). Paths are relative to baseUrl (/docs/).
        redirects: [
          {
            // Renamed in #44470 (Automation Blueprints terminology rebrand)
            from: '/guides/automation-templates',
            to: '/guides/automation-blueprints',
          },
          {
            from: '/guides/run-alice-with-nous-portal',
            to: '/guides/run-alice-with-nous-portal',
          },
          {
            from: '/guides/build-a-alice-plugin',
            to: '/guides/build-a-alice-plugin',
          },
          {
            from: '/guides/use-voice-mode-with-alice',
            to: '/guides/use-voice-mode-with-alice',
          },
          {
            from: '/guides/use-mcp-with-alice',
            to: '/guides/use-mcp-with-alice',
          },
          {
            from: '/guides/use-soul-with-alice',
            to: '/guides/use-soul-with-alice',
          },
          {
            from: '/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-alice-agent',
            to: '/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-alice-agent',
          },
          {
            from: '/user-guide/skills/bundled/software-development/software-development-alice-agent-skill-authoring',
            to: '/user-guide/skills/bundled/software-development/software-development-alice-agent-skill-authoring',
          },
          {
            from: '/user-guide/skills/optional/devops/devops-alice-s6-container-supervision',
            to: '/user-guide/skills/optional/devops/devops-alice-s6-container-supervision',
          },
        ],
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',  // Docs at the root of /docs/
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/Stuko0/alice-agent/edit/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          changefreq: 'weekly',
          priority: 0.7,
          ignorePatterns: ['/tags/**'],
          filename: 'sitemap.xml',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/alice-agent-banner.png',
    metadata: [
      { name: 'keywords', content: 'AI agent, autonomous coding, AI assistant, open source, CLI, terminal, code generation, self-improving' },
      { name: 'description', content: 'Alice Agent is a self-improving AI agent that runs across CLI, messaging platforms, desktop, and web. Open source with skills, plugins, and memory.' },
      { property: 'og:title', content: 'Alice Agent - The Self-Improving AI Agent' },
      { property: 'og:description', content: 'Open source AI agent with skills, plugins, memory, and multi-platform support. Runs in CLI, Telegram, Discord, desktop, and web.' },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: 'https://alice-agent.stuko.dev' },
      { property: 'og:image', content: 'https://alice-agent.stuko.dev/docs/img/alice-agent-banner.png' },
      { property: 'og:site_name', content: 'Alice Agent' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: 'Alice Agent - The Self-Improving AI Agent' },
      { name: 'twitter:description', content: 'Open source AI agent with skills, plugins, memory, and multi-platform support.' },
      { name: 'twitter:image', content: 'https://alice-agent.stuko.dev/docs/img/alice-agent-banner.png' },
      { name: 'robots', content: 'index, follow, max-image-preview:large, max-snippet:-1' },
    ],
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: true,
      },
    },
    navbar: {
      title: 'Alice Agent',
      logo: {
        alt: 'Alice Agent',
        src: 'img/logo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/skills',
          label: 'Skills',
          position: 'left',
        },
        {
          href: 'https://alice-agent.stuko.dev/',
          label: 'Download',
          position: 'left',
        },
        {
          type: 'localeDropdown',
          position: 'right',
        },
        {
          href: 'https://alice-agent.stuko.dev',
          label: 'Home',
          position: 'right',
        },
        {
          href: 'https://github.com/Stuko0/alice-agent',
          label: 'GitHub',
          position: 'right',
        },
        {
          href: 'https://discord.gg/Stuko',
          label: 'Discord',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting Started', to: '/getting-started/quickstart' },
            { label: 'User Guide', to: '/user-guide/cli' },
            { label: 'Developer Guide', to: '/developer-guide/architecture' },
            { label: 'Reference', to: '/reference/cli-commands' },
          ],
        },
        {
          title: 'Community',
          items: [
            { label: 'Discord', href: 'https://discord.gg/Stuko' },
            { label: 'GitHub Issues', href: 'https://github.com/Stuko0/alice-agent/issues' },
            { label: 'Skills Hub', href: 'https://agentskills.io' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'Desktop Download', href: 'https://alice-agent.stuko.dev/' },
            { label: 'GitHub', href: 'https://github.com/Stuko0/alice-agent' },
            { label: 'Stuko', href: 'https://stuko.dev' },
          ],
        },
      ],
      copyright: `Built by <a href="https://stuko.dev">Stuko</a> · MIT License · ${new Date().getFullYear()}`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'yaml', 'json', 'python', 'toml'],
    },
    mermaid: {
      theme: {light: 'neutral', dark: 'dark'},
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
