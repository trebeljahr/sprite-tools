'use client';

import { useState, useCallback, useRef } from 'react';

export interface ViewState {
  zoom: number;
  offset: { x: number; y: number };
}

export interface UseViewportOptions {
  minZoom?: number;
  maxZoom?: number;
  initialZoom?: number;
  zoomSensitivity?: number;
}

export function useViewport(options: UseViewportOptions = {}) {
  const {
    minZoom = 0.1,
    maxZoom = 10,
    initialZoom = 1,
    zoomSensitivity = 0.001,
  } = options;

  const [view, setView] = useState<ViewState>({
    zoom: initialZoom,
    offset: { x: 0, y: 0 },
  });

  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });

  const resetView = useCallback(() => {
    setView({ zoom: initialZoom, offset: { x: 0, y: 0 } });
  }, [initialZoom]);

  const setZoomIn = useCallback(() => {
    setView((prev) => {
      const newZoom = Math.min(prev.zoom * 1.2, maxZoom);
      return { ...prev, zoom: newZoom };
    });
  }, [maxZoom]);

  const setZoomOut = useCallback(() => {
    setView((prev) => {
      const newZoom = Math.max(prev.zoom * 0.8, minZoom);
      return { ...prev, zoom: newZoom };
    });
  }, [minZoom]);

  const handleWheel = useCallback(
    (e: WheelEvent | React.WheelEvent, element: HTMLElement | null) => {
      if (!element) return;
      
      const rect = element.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Snappier, more responsive zoom factor
      const zoomFactor = Math.pow(1.1, -e.deltaY / 200);

      setView((prev) => {
        const newZoom = Math.min(Math.max(prev.zoom * zoomFactor, minZoom), maxZoom);
        
        // Exact 1:1 zoom-to-mouse-point calculation
        return {
          zoom: newZoom,
          offset: {
            x: mouseX - (mouseX - prev.offset.x) * (newZoom / prev.zoom),
            y: mouseY - (mouseY - prev.offset.y) * (newZoom / prev.zoom),
          },
        };
      });
    },
    [minZoom, maxZoom]
  );

  const startPanning = useCallback((e: React.MouseEvent | MouseEvent) => {
    setIsPanning(true);
    panStart.current = {
      x: e.clientX - view.offset.x,
      y: e.clientY - view.offset.y,
    };
  }, [view.offset]);

  const updatePanning = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!isPanning) return;
    setView((prev) => ({
      ...prev,
      offset: {
        x: e.clientX - panStart.current.x,
        y: e.clientY - panStart.current.y,
      },
    }));
  }, [isPanning]);

  const stopPanning = useCallback(() => {
    setIsPanning(false);
  }, []);

  return {
    view,
    setView,
    isPanning,
    resetView,
    setZoomIn,
    setZoomOut,
    handleWheel,
    startPanning,
    updatePanning,
    stopPanning,
  };
}
