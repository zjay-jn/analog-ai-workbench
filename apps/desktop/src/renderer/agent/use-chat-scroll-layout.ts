import {useLayoutEffect, type RefObject} from 'react';

// The native scroll track spans the pane; reserve the fixed composer's height
// inside the transcript so the last reply and keyboard focus stay above it.
export function useChatScrollLayout(
  transcript: RefObject<HTMLDivElement | null>,
  footer: RefObject<HTMLDivElement | null>,
  followTail: RefObject<boolean>,
): void {
  useLayoutEffect(() => {
    const scroll = transcript.current, dock = footer.current;
    if (!scroll || !dock) return;
    const measure = () => {
      const reserve = `${dock.getBoundingClientRect().height + 14}px`;
      if (scroll.style.getPropertyValue('--chat-footer-space') !== reserve) {
        scroll.style.setProperty('--chat-footer-space', reserve);
      }
      if (followTail.current) scroll.scrollTop = scroll.scrollHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [transcript, footer, followTail]);
}
