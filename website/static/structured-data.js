// JSON-LD structured data for Google indexing (free SEO)
// Injected into <head> on every page via docusaurus.config.ts scripts[]

(function() {
  if (typeof document === 'undefined') return;

  // WebSite schema with SearchAction (enables sitelinks search box in Google)
  const webSiteSchema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "Alice Agent",
    "url": "https://alice-agent.stuko.dev/docs/",
    "description": "Alice Agent is a self-improving AI agent that runs across CLI, messaging platforms, desktop, and web.",
    "publisher": {
      "@type": "Organization",
      "name": "Stuko",
      "url": "https://stuko.dev"
    },
    "potentialAction": {
      "@type": "SearchAction",
      "target": {
        "@type": "EntryPoint",
        "urlTemplate": "https://alice-agent.stuko.dev/docs/?q={search_term_string}"
      },
      "query-input": "required name=search_term_string"
    }
  };

  // SoftwareApplication schema (for the software itself)
  const softwareSchema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Alice Agent",
    "description": "A self-improving AI agent with persistent memory, agent-created skills, and a messaging gateway supporting 21+ platforms.",
    "url": "https://github.com/Stuko0/alice-agent",
    "downloadUrl": "https://alice-agent.stuko.dev/docs/getting-started/installation",
    "applicationCategory": "DeveloperApplication",
    "operatingSystem": "Linux, macOS, Windows, Android (Termux)",
    "license": "https://opensource.org/licenses/MIT",
    "softwareVersion": "0.23.0",
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "USD"
    },
    "author": {
      "@type": "Organization",
      "name": "Stuko",
      "url": "https://stuko.dev"
    },
    "sameAs": [
      "https://github.com/Stuko0/alice-agent",
      "https://discord.gg/Stuko"
    ]
  };

  function injectSchema(schema, id) {
    // Remove existing if present (SPA navigation)
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = id;
    script.textContent = JSON.stringify(schema);
    document.head.appendChild(script);
  }

  // Inject on initial load
  injectSchema(webSiteSchema, 'ld-websiteschema');
  injectSchema(softwareSchema, 'ld-softwareschema');

  // Re-inject on Docusaurus SPA navigation
  if (typeof window !== 'undefined') {
    const originalPushState = history.pushState;
    history.pushState = function() {
      originalPushState.apply(this, arguments);
      setTimeout(function() {
        injectSchema(webSiteSchema, 'ld-websiteschema');
        injectSchema(softwareSchema, 'ld-softwareschema');
      }, 100);
    };
  }
})();
