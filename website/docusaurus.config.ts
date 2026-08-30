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
          editUrl: 'https://10.1.200.116:3000/arquant-admin/NewAlice/edit/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/alice-agent-banner.png',
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
          href: 'https://10.1.200.116:3000/arquant-admin/NewAlice',
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
            { label: 'GitHub Issues', href: 'https://10.1.200.116:3000/arquant-admin/NewAlice/issues' },
            { label: 'Skills Hub', href: 'https://agentskills.io' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'Desktop Download', href: 'https://alice-agent.stuko.dev/' },
            { label: 'GitHub', href: 'https://10.1.200.116:3000/arquant-admin/NewAlice' },
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
