import { useState, useEffect } from 'react';

export function useLocalStorageSync(getter) {
  const [data, setData] = useState(getter);

  const refresh = () => {
    setData(getter());
  };

  useEffect(() => {
    const handler = () => setData(getter());
    window.addEventListener('comanufacturing:datachange', handler);
    return () => window.removeEventListener('comanufacturing:datachange', handler);
  }, [getter]);

  return [data, refresh];
}
