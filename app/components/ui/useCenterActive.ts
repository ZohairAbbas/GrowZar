import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

/**
 * A tab strip that scrolls sideways on a phone (pre-Wave-1 pack 3) brings its
 * current tab into view. It sets scrollLeft rather than calling scrollIntoView,
 * which would also scroll the page.
 */
export function useCenterActive<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const strip = ref.current;
    const active = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !active || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = active.offsetLeft - strip.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
  }, [pathname]);
  return ref;
}
