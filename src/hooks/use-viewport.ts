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
}

export function useViewport(options: UseViewportOptions = {}) {
  const {
    minZoom = 0.01,
    maxZoom = 50,
    initialZoom = 1,
  } = options;

  const [view, setView] = useState<ViewState>({
    zoom: initialZoom,
    offset: { x: 0, y: 0 },
  });

  const [baseView, setBaseView] = useState<ViewState>({
    zoom: initialZoom,
    offset: { x: 0, y: 0 },
  });

  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, startOffset: { x: 0, y: 0 } });
  const containerRef = useRef<HTMLDivElement | null>(null);

  const zoomAtPoint = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((prev) => {
      const newZoom = Math.min(Math.max(prev.zoom * factor, minZoom), maxZoom);
      
      let pivotX = cx;
      let pivotY = cy;
      
      const element = containerRef.current;
      if (pivotX === undefined || pivotY === undefined) {
        if (element) {
          const rect = element.getBoundingClientRect();
          pivotX = rect.width / 2;
          pivotY = rect.height / 2;
        } else {
          pivotX = 0;
          pivotY = 0;
        }
      }

      return {
        zoom: newZoom,
        offset: {
          x: pivotX - (pivotX - prev.offset.x) * (newZoom / prev.zoom),
          y: pivotY - (pivotY - prev.offset.y) * (newZoom / prev.zoom),
        },
      };
    });
  }, [minZoom, maxZoom]);

  const resetView = useCallback(() => {
    setView(baseView);
  }, [baseView]);

  const fitToView = useCallback((contentWidth: number, contentHeight: number, padding = 40) => {
    const element = containerRef.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const availableWidth = rect.width - padding;
    const availableHeight = rect.height - padding;

    const zoomX = availableWidth / contentWidth;
    const zoomY = availableHeight / contentHeight;
    const newZoom = Math.min(zoomX, zoomY, 1);

    const offsetX = (rect.width - contentWidth * newZoom) / 2;
    const offsetY = (rect.height - contentHeight * newZoom) / 2;

    const newView = { zoom: newZoom, offset: { x: offsetX, y: offsetY } };
    setView(newView);
    setBaseView(newView);
  }, []);

  const setZoomIn = useCallback(() => zoomAtPoint(1.2), [zoomAtPoint]);
  const setZoomOut = useCallback(() => zoomAtPoint(0.8), [zoomAtPoint]);

  const handleWheel = useCallback(
    (e: WheelEvent | React.WheelEvent, elementOverride?: HTMLElement | null) => {
      const element = elementOverride || containerRef.current;
      if (!element) return;
      
      const rect = element.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const divisor = e.ctrlKey ? 80 : 160;
      const zoomFactor = Math.pow(1.1, -e.deltaY / divisor);
      zoomAtPoint(zoomFactor, mouseX, mouseY);
    },
    [zoomAtPoint]
  );

  const startPanning = useCallback((e: React.MouseEvent | MouseEvent) => {
    setIsPanning(true);
    panStart.current = {
      x: e.clientX,
      y: e.clientY,
      startOffset: { ...view.offset },
    };
  }, [view.offset]);

  const updatePanning = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!isPanning) return;
    
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    
    setView((prev) => ({
      ...prev,
      offset: {
        x: panStart.current.startOffset.x + dx,
        y: panStart.current.startOffset.y + dy,
      },
    }));
  }, [isPanning]);

  const stopPanning = useCallback(() => {
    setIsPanning(false);
  }, []);

  return {
    view,
    setView,
    baseView,
    setBaseView,
    isPanning,
    containerRef,
    resetView,
    fitToView,
    setZoomIn,
    setZoomOut,
    handleWheel,
    startPanning,
    updatePanning,
    stopPanning,
  };
}
