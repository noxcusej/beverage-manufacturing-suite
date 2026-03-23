import { useState, useEffect, useCallback } from 'react';

export function useLocalStorageSync(getter, deps = []) {
  const [data, setData] = useState(getter);

  const refresh = useCallback(() => {
    setData(getter());
  }, deps);

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener('comanufacturing:datachange', handler);
    return () => window.removeEventListener('comanufacturing:datachange', handler);
  }, [refresh]);

  return [data, refresh];
}
