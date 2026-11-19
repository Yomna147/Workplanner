import { useEffect } from 'react';
import { fitAllSelects, fitSelectWidth, shouldAutoFitSelect } from '../utils/fitSelectWidth';

export function useGlobalSelectAutoWidth() {
  useEffect(() => {
    let frame = null;

    const scheduleFit = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        fitAllSelects();
      });
    };

    const handleChange = (event) => {
      if (shouldAutoFitSelect(event.target)) {
        fitSelectWidth(event.target);
      }
    };

    scheduleFit();

    const observer = new MutationObserver(() => {
      scheduleFit();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    document.addEventListener('change', handleChange);
    window.addEventListener('resize', scheduleFit);

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      observer.disconnect();
      document.removeEventListener('change', handleChange);
      window.removeEventListener('resize', scheduleFit);
    };
  }, []);
}
