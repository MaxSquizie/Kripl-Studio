import { memo, useEffect, useRef, useState } from "react";

export interface MessageImagesProps {
  imagePaths?: string[] | undefined;
  /** Already available image sources from older in-memory messages. */
  images?: string[] | undefined;
  onOpenImage(src: string): void;
}

interface PreviewState {
  path: string;
  dataUrl?: string;
  failed?: boolean;
}

const Thumbnail = memo(function Thumbnail({ path, src, onOpenImage }: {
  path?: string | undefined;
  src?: string | undefined;
  onOpenImage(src: string): void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const currentPreview = preview?.path === path ? preview : null;
  const imageSrc = src ?? currentPreview?.dataUrl;
  const failed = Boolean(currentPreview?.failed || (imageSrc && imageSrc === brokenSrc));
  const name = path?.split(/[\\/]/).pop() || "Прикреплённое изображение";

  useEffect(() => {
    if (src !== undefined || !path) return;
    // The placeholder is always mounted, including while its button is
    // disabled, so the observer has geometry before any file is read.
    const element = buttonRef.current;
    if (!element) return;
    let cancelled = false;
    let started = false;
    let observer: IntersectionObserver | undefined;

    const load = (): void => {
      if (cancelled || started) return;
      started = true;
      observer?.disconnect();
      void window.kripl.readAttachPreview(path).then((result) => {
        if (cancelled) return;
        setPreview(result.ok && result.dataUrl
          ? { path, dataUrl: result.dataUrl }
          : { path, failed: true });
      }).catch(() => {
        if (!cancelled) setPreview({ path, failed: true });
      });
    };

    if (typeof window.IntersectionObserver === "function") {
      observer = new window.IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      }, {
        root: element.closest(".conversation"),
        rootMargin: "400px"
      });
      observer.observe(element);
    } else {
      load();
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      // No shared cache: unmounting the thumbnail also releases its data URL.
      // The IPC read itself cannot be aborted; a late result is discarded.
    };
  }, [path, src]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className="message-image-button message-image-thumbnail"
      disabled={!imageSrc || failed}
      aria-busy={!imageSrc && !failed}
      title={failed ? `Не удалось загрузить: ${name}` : `Открыть изображение: ${name}`}
      onClick={() => { if (imageSrc && !failed) onOpenImage(imageSrc); }}
    >
      {imageSrc && !failed ? (
        <img
          src={imageSrc}
          alt={name}
          loading="lazy"
          decoding="async"
          onError={() => setBrokenSrc(imageSrc)}
        />
      ) : (
        <span className="message-image-placeholder">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="8" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="m4 17 5-5 4 4 3-3 5 5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          <span>{failed ? "Изображение недоступно" : name}</span>
        </span>
      )}
    </button>
  );
});

/** File-backed previews live only in mounted thumbnails, never in the feed. */
export const MessageImages = memo(function MessageImages({ imagePaths, images, onOpenImage }: MessageImagesProps) {
  if (!imagePaths?.length && !images?.length) return null;
  return (
    <div className="message-images">
      {images?.map((src, index) => (
        <Thumbnail key={`legacy:${index}`} src={src} onOpenImage={onOpenImage} />
      ))}
      {imagePaths?.map((path, index) => (
        <Thumbnail key={`path:${index}:${path}`} path={path} onOpenImage={onOpenImage} />
      ))}
    </div>
  );
});
