import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const commands = [
  { name: 'Go to Formula Calculator', description: 'Recipe scaling & costing', path: '/batch-calculator', shortcut: '' },
  { name: 'Go to Run Quoting', description: 'Packaging & services calculator', path: '/copacking', shortcut: '' },
  { name: 'Go to Clients', description: 'Client roster & profiles', path: '/clients', shortcut: '' },
  { name: 'Go to Inventory', description: 'Ingredient catalog', path: '/inventory', shortcut: '' },
  { name: 'Go to Packaging', description: 'Packaging catalog', path: '/packaging', shortcut: '' },
  { name: 'Go to Services', description: 'Service-fee catalog', path: '/services', shortcut: '' },
  { name: 'Go to Formulas', description: 'Formula library', path: '/formulas', shortcut: '' },
  { name: 'Go to Summary', description: 'Run summary & comparison', path: '/summary', shortcut: '' },
];

export default function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  const filtered = query
    ? commands.filter(
        (cmd) =>
          cmd.name.toLowerCase().includes(query.toLowerCase()) ||
          (cmd.description && cmd.description.toLowerCase().includes(query.toLowerCase()))
      )
    : commands;

  const open = useCallback(() => {
    setIsOpen(true);
    setQuery('');
    setSelectedIndex(0);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  const execute = useCallback(
    (index) => {
      const cmd = filtered[index];
      if (cmd) {
        close();
        if (cmd.path) navigate(cmd.path);
        if (cmd.action) cmd.action();
      }
    },
    [filtered, close, navigate]
  );

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        open();
      }
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, open, close]);

  useEffect(() => {
    if (isOpen && inputRef.current) inputRef.current.focus();
  }, [isOpen]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execute(selectedIndex);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="command-palette-overlay" onClick={close} />
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="command-palette-input-wrapper">
          <input
            ref={inputRef}
            type="text"
            placeholder="Type a command or search..."
            aria-label="Search commands"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            autoComplete="off"
          />
        </div>
        <div className="command-palette-results">
          {filtered.length === 0 ? (
            <div className="command-palette-empty">No commands found for "{query}"</div>
          ) : (
            filtered.map((cmd, index) => (
              <div
                key={cmd.name}
                className={`command-palette-item ${index === selectedIndex ? 'selected' : ''}`}
                onClick={() => execute(index)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <div>
                  <div className="command-palette-item-name">{cmd.name}</div>
                  {cmd.description && (
                    <div className="command-palette-item-desc">{cmd.description}</div>
                  )}
                </div>
                {cmd.shortcut && <kbd>{cmd.shortcut}</kbd>}
              </div>
            ))
          )}
        </div>
        <div className="command-palette-footer">
          <div>
            <kbd>↑↓</kbd> Navigate <kbd>Enter</kbd> Execute
          </div>
          <div>
            <kbd>Esc</kbd> Close
          </div>
        </div>
      </div>
    </>
  );
}
