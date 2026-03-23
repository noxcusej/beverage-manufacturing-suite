import { Link } from 'react-router-dom';

const cards = [
  {
    to: '/batch-calculator',
    icon: '\ud83e\uddea',
    title: 'Batch Calculator',
    description: 'Calculate ingredient costs, scale recipes, and analyze batch economics with MOQ optimization.',
    badges: ['Imperial/Metric', 'Excel Export', 'Analytics'],
  },
  {
    to: '/copacking',
    icon: '\ud83d\udce6',
    title: 'Co-Packing Calculator',
    badge: 'Updated',
    description: 'Calculate packaging materials and co-packing services with smart auto-population.',
    badges: ['Auto-Calc', 'Categories', 'Services'],
  },
  {
    to: '/inventory',
    icon: '\ud83d\udcca',
    title: 'Inventory Management',
    badge: 'New',
    description: 'Manage ingredients, track stock levels, and configure price tiers with keyboard navigation.',
    badges: ['Price Tiers', 'Keyboard Nav', 'ERP Ready'],
  },
  {
    to: '/packaging',
    icon: '\ud83d\udcb0',
    title: 'Packaging & Services',
    description: 'Maintain pricing for packaging materials, services, and supplier relationships.',
    badges: ['Vendors', 'Autocomplete', 'CSV Export'],
  },
];

export default function Home() {
  return (
    <div className="home-page">
      <div className="home-container">
        <div className="home-header">
          <h1>Co-Manufacturing Calculator</h1>
          <p>Professional batch costing and production planning tools</p>
        </div>

        <div className="home-grid">
          {cards.map((card) => (
            <Link key={card.to} to={card.to} className="home-card">
              <div className="card-icon">{card.icon}</div>
              <div className="card-title">
                {card.title}
                {card.badge && <span className="new-badge">{card.badge}</span>}
              </div>
              <div className="card-description">{card.description}</div>
              <div className="card-features">
                {card.badges.map((b) => (
                  <span key={b} className="feature-badge">{b}</span>
                ))}
              </div>
            </Link>
          ))}
        </div>

        <div className="info-box">
          <h3>What's New in This Update</h3>
          <ul>
            <li><strong>React SPA:</strong> Fully refactored as a single-page React application</li>
            <li><strong>Smart Auto-Population:</strong> Co-packing quantities calculate automatically based on categories</li>
            <li><strong>Command Palette:</strong> Press <kbd>Cmd</kbd>+<kbd>K</kbd> anywhere for quick actions</li>
            <li><strong>Keyboard Navigation:</strong> Navigate inventory with arrow keys, delete items, all without mouse</li>
            <li><strong>Master-Detail UI:</strong> Inventory, packaging, and services with side-by-side layout</li>
            <li><strong>Unified Data Layer:</strong> All pages share data via localStorage with real-time sync</li>
          </ul>
        </div>

        <div className="keyboard-hint">
          <strong>Keyboard Shortcuts: </strong>
          <kbd>Cmd</kbd>+<kbd>K</kbd> Command Palette
        </div>
      </div>
    </div>
  );
}
