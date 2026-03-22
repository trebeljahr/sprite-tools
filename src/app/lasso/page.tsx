'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Upload, Download, Trash2, Move, Scissors, Undo, RefreshCw, Sparkles, Palette } from 'lucide-react';
import { toast } from 'sonner';
import { cn, sampleBackground, applyChromaKey } from '@/lib/utils';
import { BackgroundRemovalSettings, type BackgroundRemovalState } from '@/components/background-removal-settings';
import { useViewport } from '@/hooks/use-viewport';
import { ViewportControls, ZoomIndicator } from '@/components/viewport-controls';

interface Point {
  x: number;
  y: number;
}

export default function LassoPage() {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [isClosed, setIsClosed] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [lastClickTime, setLastClickTime] = useState(0);
  
  // Main Canvas View State using shared hook
  const canvasViewport = useViewport();
  const [mode, setMode] = useState<'lasso' | 'pan'>('lasso');
  const [mousePos, setMousePos] = useState<Point | null>(null);

  // Track movement during mouse down to differentiate click vs drag
  const dragStartPos = useRef<{ x: number, y: number } | null>(null);
  const hasDragged = useRef(false);

  // Preview View State using shared hook
  const previewViewport = useViewport();
  const [gridTheme, setGridTheme] = useState<'light' | 'dark'>('light');

  // Background Removal Settings
  const [brState, setBrState] = useState<BackgroundRemovalState>({
    removeBackground: false,
    autoCrop: true,
    similarity: 30,
    softness: 10,
    spill: 20,
    choke: 1,
  });
  const [showAdvancedChroma, setShowAdvancedChroma] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          setImage(img);
          setPoints([]);
          canvasViewport.resetView();
          setIsClosed(false);
          setPreviewUrl(null);
        };
        img.src = event.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  const generateProcessedCanvas = useCallback(() => {
    if (!image || points.length < 3) return null;

    const minX = Math.min(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y));
    const maxX = Math.max(...points.map(p => p.x));
    const maxY = Math.max(...points.map(p => p.y));
    const width = maxX - minX;
    const height = maxY - minY;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const sampled = sampleBackground(image, points);

    if (!brState.removeBackground) {
      ctx.fillStyle = `rgb(${sampled.r}, ${sampled.g}, ${sampled.b})`;
      ctx.fillRect(0, 0, width, height);
    }

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x - minX, points[0].y - minY);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x - minX, points[i].y - minY);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(image, -minX, -minY);
    ctx.restore();

    if (brState.removeBackground) {
      applyChromaKey(ctx, width, height, sampled, brState);
    }

    if (brState.removeBackground && brState.autoCrop) {
      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data;
      let gMinX = width, gMinY = height, gMaxX = 0, gMaxY = 0;
      let found = false;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] > 0) {
            if (x < gMinX) gMinX = x;
            if (y < gMinY) gMinY = y;
            if (x > gMaxX) gMaxX = x;
            if (y > gMaxY) gMaxY = y;
            found = true;
          }
        }
      }

      if (found) {
        const padding = 2;
        const cropX = Math.max(0, gMinX - padding);
        const cropY = Math.max(0, gMinY - padding);
        const cropW = Math.min(width - cropX, gMaxX - gMinX + 1 + padding * 2);
        const cropH = Math.min(height - cropY, gMaxY - gMinY + 1 + padding * 2);

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = cropW;
        cropCanvas.height = cropH;
        const cctx = cropCanvas.getContext('2d');
        if (cctx) {
          cctx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
          return cropCanvas;
        }
      }
    }

    return canvas;
  }, [image, points, brState]);

  const processCutout = useCallback(async (silent = false) => {
    setIsProcessing(true);
    // Short delay for better UX feel
    await new Promise(r => setTimeout(r, 300));
    const canvas = generateProcessedCanvas();
    if (canvas) {
      setPreviewUrl(canvas.toDataURL('image/png'));
      if (!silent) toast.success('Cutout processed!');
      previewViewport.resetView();
    }
    setIsProcessing(false);
  }, [generateProcessedCanvas, previewViewport]);

  // Auto-process when selection is closed
  useEffect(() => {
    if (isClosed && !previewUrl && !isProcessing) {
      processCutout(true);
    }
  }, [isClosed, previewUrl, isProcessing, processCutout]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvasViewport.view.offset.x, canvasViewport.view.offset.y);
    ctx.scale(canvasViewport.view.zoom, canvasViewport.view.zoom);
    ctx.drawImage(image, 0, 0);

    if (points.length > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, image.width, image.height);
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      if (isClosed) ctx.closePath();
      else if (mousePos) ctx.lineTo(mousePos.x, mousePos.y);
      ctx.clip('evenodd');
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, image.width, image.height);
      ctx.restore();
    }

    if (points.length > 0) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      
      if (isClosed) {
        ctx.closePath();
        ctx.strokeStyle = '#00ff00';
        ctx.fillStyle = 'rgba(0, 255, 0, 0.2)';
        ctx.lineWidth = 2 / canvasViewport.view.zoom;
        ctx.fill();
        ctx.stroke();
      } else if (mode === 'lasso') {
        if (mousePos) ctx.lineTo(mousePos.x, mousePos.y);
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 2 / canvasViewport.view.zoom;
        ctx.setLineDash([5 / canvasViewport.view.zoom, 5 / canvasViewport.view.zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      points.forEach((p, i) => {
        ctx.fillStyle = i === 0 ? (isClosed ? '#00ff00' : '#ffff00') : '#ff0000';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 / canvasViewport.view.zoom, 0, Math.PI * 2);
        ctx.fill();
        
        if (i === 0 && mousePos && !isClosed && points.length > 2) {
          const dist = Math.sqrt(Math.pow(mousePos.x - p.x, 2) + Math.pow(mousePos.y - p.y, 2));
          if (dist < 20 / canvasViewport.view.zoom) {
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 3 / canvasViewport.view.zoom;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 15 / canvasViewport.view.zoom, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      });
    }
    ctx.restore();
  }, [image, points, canvasViewport.view, mode, mousePos, isClosed]);

  useEffect(() => { draw(); }, [draw]);

  const getCanvasPoint = (e: React.MouseEvent | React.WheelEvent | WheelEvent): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: ((e.clientX - rect.left) * scaleX - canvasViewport.view.offset.x) / canvasViewport.view.zoom,
      y: ((e.clientY - rect.top) * scaleY - canvasViewport.view.offset.y) / canvasViewport.view.zoom
    };
  };

  const undoLastPoint = useCallback(() => {
    if (isClosed) setIsClosed(false);
    else setPoints(prev => prev.slice(0, -1));
  }, [isClosed]);

  const clearSelection = useCallback(() => {
    setPoints([]);
    setIsClosed(false);
    setPreviewUrl(null);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      undoLastPoint();
      return;
    }

    dragStartPos.current = { x: e.clientX, y: e.clientY };
    hasDragged.current = false;
    canvasViewport.startPanning(e);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const p = getCanvasPoint(e);
    setMousePos(p);

    if (dragStartPos.current) {
      const dist = Math.sqrt(
        Math.pow(e.clientX - dragStartPos.current.x, 2) + 
        Math.pow(e.clientY - dragStartPos.current.y, 2)
      );
      if (dist > 5) {
        hasDragged.current = true;
      }
    }

    canvasViewport.updatePanning(e);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    const wasDrag = hasDragged.current;
    canvasViewport.stopPanning();
    dragStartPos.current = null;

    if (!wasDrag && mode === 'lasso' && image && !isClosed && e.button === 0) {
      const p = getCanvasPoint(e);
      const now = Date.now();
      
      if (now - lastClickTime < 300 && points.length > 2) {
        setIsClosed(true);
        setLastClickTime(0);
        return;
      }
      setLastClickTime(now);

      if (points.length > 2) {
        const firstPoint = points[0];
        const dist = Math.sqrt(Math.pow(p.x - firstPoint.x, 2) + Math.pow(p.y - firstPoint.y, 2));
        if (dist < 20 / canvasViewport.view.zoom) {
          setIsClosed(true);
          return;
        }
      }
      setPoints([...points, p]);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      canvasViewport.handleWheel(e, canvas);
    };

    const preventDefault = (e: Event) => e.preventDefault();
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('gesturestart', preventDefault, { passive: false });
    canvas.addEventListener('gesturechange', preventDefault, { passive: false });

    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('gesturestart', preventDefault);
      canvas.removeEventListener('gesturechange', preventDefault);
    };
  }, [canvasViewport]);

  useEffect(() => {
    const container = previewContainerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      previewViewport.handleWheel(e, container);
    };

    const preventDefault = (e: Event) => e.preventDefault();
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('gesturestart', preventDefault, { passive: false });
    container.addEventListener('gesturechange', preventDefault, { passive: false });

    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('gesturestart', preventDefault);
      container.removeEventListener('gesturechange', preventDefault);
    };
  }, [previewViewport]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undoLastPoint();
      } else if (e.key === 'Enter' && points.length > 2 && !isClosed) {
        e.preventDefault();
        setIsClosed(true);
      } else if (e.key === ' ') {
        e.preventDefault();
        clearSelection();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        clearSelection();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [points, isClosed, undoLastPoint, clearSelection]);

  const exportClippedImage = () => {
    if (previewUrl) {
      const link = document.createElement('a');
      link.download = 'cutout.png';
      link.href = previewUrl;
      link.click();
      toast.success('Image exported successfully!');
    }
  };

  return (
    <div className="container mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold mb-6 text-center">Lasso Cutout Tool</h1>
      
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <Card className="p-4 space-y-4 h-fit">
            <div className="space-y-2">
              <Label>Upload Image</Label>
              <div className="flex items-center justify-center w-full">
                <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-lg cursor-pointer bg-muted hover:bg-muted/80">
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <Upload className="w-8 h-8 mb-3 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Click to upload</p>
                  </div>
                  <input type="file" className="hidden" onChange={handleImageUpload} accept="image/*" />
                </label>
              </div>
            </div>

            <div className="text-xs text-muted-foreground space-y-2 mt-4 border-t pt-4">
              <p className="font-semibold text-foreground">Shortcuts:</p>
              <div className="grid grid-cols-2 gap-y-1">
                <span>Finish:</span> <span className="font-mono bg-muted px-1 rounded text-[10px]">Enter</span>
                <span>Undo:</span> <span className="font-mono bg-muted px-1 rounded text-[10px]">Ctrl+Z / Right-Click</span>
                <span>Clear:</span> <span className="font-mono bg-muted px-1 rounded text-[10px]">Space / Esc</span>
                <span>Move:</span> <span className="font-mono bg-muted px-1 rounded text-[10px]">Click & Drag</span>
              </div>
            </div>
          </Card>
        </div>

        <div className="lg:col-span-3 flex flex-col gap-6">
          <Card className="relative overflow-hidden min-h-[600px] flex flex-col border shadow-lg" onContextMenu={(e) => e.preventDefault()}>
            <div className="flex items-center justify-between p-2 bg-muted/30 border-b backdrop-blur-sm z-10">
              <div className="flex items-center gap-1">
                <Button 
                  variant={mode === 'lasso' ? 'default' : 'ghost'} 
                  size="sm" 
                  className="h-8 px-3"
                  onClick={() => setMode('lasso')}
                  title="Lasso Tool"
                >
                  <Scissors className="h-4 w-4 mr-2" /> Lasso
                </Button>
                <Button 
                  variant={mode === 'pan' ? 'default' : 'ghost'} 
                  size="sm" 
                  className="h-8 px-3"
                  onClick={() => setMode('pan')}
                  title="Pan Tool"
                >
                  <Move className="h-4 w-4 mr-2" /> Pan
                </Button>
                <div className="w-px h-4 bg-border mx-1" />
                
                <ViewportControls 
                  onZoomIn={canvasViewport.setZoomIn}
                  onZoomOut={canvasViewport.setZoomOut}
                  onReset={canvasViewport.resetView}
                />
              </div>

              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-8" onClick={undoLastPoint} disabled={points.length === 0}>
                  <Undo className="mr-2 h-4 w-4" /> Undo
                </Button>
                <Button variant="ghost" size="sm" className="h-8 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={clearSelection} disabled={points.length === 0}>
                  <Trash2 className="mr-2 h-4 w-4" /> Clear
                </Button>
              </div>
            </div>

            <div className="flex-1 bg-muted/5 flex items-center justify-center relative" ref={containerRef}>
              {!image && (
                <div className="text-muted-foreground flex flex-col items-center">
                  <Upload className="h-12 w-12 mb-4 opacity-20" />
                  <p>Upload an image to start</p>
                </div>
              )}
              <canvas
                ref={canvasRef}
                width={image?.width || 800}
                height={image?.height || 600}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                className={cn(
                  "max-w-full max-h-full object-contain",
                  mode === 'pan' ? 'cursor-move' : 'cursor-crosshair',
                  canvasViewport.isPanning && 'cursor-grabbing'
                )}
              />
              {image && (
                <ZoomIndicator zoom={canvasViewport.view.zoom} className="absolute bottom-4 right-4" />
              )}
            </div>
          </Card>

          {isClosed && (
            <Card className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-primary" />
                  Process Selection
                </CardTitle>
                <Button onClick={() => processCutout()} disabled={isProcessing} className="bg-primary hover:bg-primary/90">
                  {isProcessing ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  {isProcessing ? 'Processing...' : 'Process Cutout'}
                </Button>
              </div>

              <div className="pt-2 border-t border-dashed">
                <BackgroundRemovalSettings 
                  state={brState}
                  setState={setBrState}
                  showAdvanced={showAdvancedChroma}
                  setShowAdvanced={setShowAdvancedChroma}
                  compact={true}
                />
              </div>
            </Card>
          )}

          {previewUrl && (
            <Card className="shadow-lg ring-1 ring-primary/10 overflow-hidden">
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0 bg-muted/20 border-b">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-lg">Final Result</CardTitle>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Toggle Background Grid Color"
                    onClick={() => setGridTheme(prev => prev === 'light' ? 'dark' : 'light')}
                  >
                    <Palette className={cn("h-4 w-4", gridTheme === 'dark' ? "text-primary" : "text-muted-foreground")} />
                  </Button>
                </div>
                <div className="flex gap-1 items-center">
                  <ViewportControls 
                    onZoomIn={previewViewport.setZoomIn}
                    onZoomOut={previewViewport.setZoomOut}
                    onReset={previewViewport.resetView}
                  />
                  <div className="w-px h-4 bg-border mx-1" />
                  <Button onClick={exportClippedImage} size="sm" className="h-8 gap-2">
                    <Download className="h-4 w-4" /> Export
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div
                  ref={previewContainerRef}
                  className={cn(
                    "aspect-square min-h-[400px] flex items-center justify-center overflow-hidden relative cursor-move touch-none bg-muted/5",
                    gridTheme === 'light' ? "checkerboard-light" : "checkerboard-dark"
                  )}
                  onMouseDown={previewViewport.startPanning}
                  onMouseMove={previewViewport.updatePanning}
                  onMouseUp={previewViewport.stopPanning}
                  onMouseLeave={previewViewport.stopPanning}
                >
                  <img
                    src={previewUrl}
                    alt="Cutout Preview"
                    className="object-contain shadow-2xl"
                    style={{
                      transform: `translate(${previewViewport.view.offset.x}px, ${previewViewport.view.offset.y}px) scale(${previewViewport.view.zoom})`,
                      transformOrigin: '0 0'
                    }}
                    draggable={false}
                  />
                  <ZoomIndicator zoom={previewViewport.view.zoom} className="absolute bottom-4 right-4" />
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
