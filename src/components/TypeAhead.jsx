import { useState, useRef, useEffect, useCallback } from 'react';

export default function TypeAhead({
  items,
  value,
  onChange,
  searchFields = ['name'],
  displayField = 'name',
  getSecondaryText,
  placeholder = 'Search...',
  style,
  className,
}) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);

  const selectedItem = items.find((i) => i.id === value);
  const displayValue = isOpen ? query : (selectedItem ? selectedItem[displayField] : '');

  const filtered = query
    ? items.filter((item) =>
        searchFields.some((field) => {
          const val = item[field];
          return val && String(val).toLowerCase().includes(query.toLowerCase());
        })
      )
    : items;

  const handleSelect = useCallback(
    (item) => {
      onChange(item.id, item);
      setQuery('');
      setIsOpen(false);
    },
    [onChange]
  );

  const handleFocus = () => {
    setQuery('');
    setIsOpen(true);
    setHighlightIndex(0);
  };

  const handleBlur = () => {
    // Delay to allow click on dropdown items
    setTimeout(() => setIsOpen(false), 200);
  };

  const handleKeyDown = (e) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        setIsOpen(true);
        setHighlightIndex(0);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlightIndex]) {
        handleSelect(filtered[highlightIndex]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (!isOpen) return;
    const el = wrapperRef.current?.querySelector('.typeahead-item.highlighted');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex, isOpen]);

  return (
    <div ref={wrapperRef} className={`typeahead-wrapper ${className || ''}`} style={{ position: 'relative', ...style }}>
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        placeholder={placeholder}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlightIndex(0);
          if (!isOpen) setIsOpen(true);
        }}
        onKeyDown={handleKeyDown}
        autoComplete="off"
      />
      {isOpen && filtered.length > 0 && (
        <div className="typeahead-dropdown">
          {filtered.map((item, idx) => (
            <div
              key={item.id}
              className={`typeahead-item ${idx === highlightIndex ? 'highlighted' : ''} ${item.id === value ? 'selected' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(item);
              }}
              onMouseEnter={() => setHighlightIndex(idx)}
            >
              <div className="typeahead-item-primary">{item[displayField]}</div>
              {getSecondaryText && (
                <div className="typeahead-item-secondary">{getSecondaryText(item)}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {isOpen && filtered.length === 0 && query && (
        <div className="typeahead-dropdown">
          <div className="typeahead-empty">No matches</div>
        </div>
      )}
    </div>
  );
}
