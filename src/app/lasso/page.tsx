'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Upload, Download, Trash2, Move, Scissors, Undo, RefreshCw, Sparkles, Palette } from 'lucide-react';
import { toast } from 'sonner';
import confetti from 'canvas-confetti';
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
  
  // View State using shared hook
  const canvasViewport = useViewport();
  const [mode, setMode] = useState<'lasso' | 'pan'>('lasso');
  const [mousePos, setMousePos] = useState<Point | null>(null);

  // Track movement during mouse down to differentiate click vs drag
  const dragStartPos = useRef<{ x: number, y: number } | null>(null);
  const hasDragged = useRef(false);

  // Preview View State using shared hook
  const previewViewport = useViewport();
  const [gridTheme, setGridTheme] = useState<'light' | 'dark'>('light');
  const previewDimensions = useRef({ w: 0, h: 0 });

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
  
  const canvasRef = canvasViewport.containerRef;
  const previewContainerRef = previewViewport.containerRef;
  const resultsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          setImage(img);
          setPoints([]);
          setIsClosed(false);
          setPreviewUrl(null);
          // Wait for next tick so containerRef is ready
          setTimeout(() => canvasViewport.fitToView(img.width, img.height), 0);
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
    await new Promise(r => setTimeout(r, 300));
    const canvas = generateProcessedCanvas();
    if (canvas) {
      setPreviewUrl(canvas.toDataURL('image/png'));
      previewDimensions.current = { w: canvas.width, h: canvas.height };
      if (!silent) toast.success('Cutout processed!');
      
      // Auto fit preview
      setTimeout(() => previewViewport.fitToView(canvas.width, canvas.height), 0);
      
      // Completion effects
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        confetti({
          particleCount: 100,
          spread: 70,
          origin: { y: 0.6 },
          colors: ['#4ade80', '#22c55e', '#3b82f6']
        });
      }, 100);
    }
    setIsProcessing(false);
  }, [generateProcessedCanvas, previewViewport]);

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

    const { zoom, offset } = canvasViewport.view;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Enable high-quality smoothing for zoomed-out views
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(zoom, zoom);
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
    ctx.restore();

    if (points.length > 0) {
      const toScreen = (p: Point) => ({
        x: p.x * zoom + offset.x,
        y: p.y * zoom + offset.y
      });

      const screenPoints = points.map(toScreen);
      const screenMouse = mousePos ? toScreen(mousePos) : null;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
      for (let i = 1; i < screenPoints.length; i++) ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
      
      if (isClosed) {
        ctx.closePath();
        ctx.strokeStyle = '#00ff00';
        ctx.fillStyle = 'rgba(0, 255, 0, 0.2)';
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      } else if (mode === 'lasso') {
        if (screenMouse) ctx.lineTo(screenMouse.x, screenMouse.y);
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      screenPoints.forEach((p, i) => {
        ctx.fillStyle = i === 0 ? (isClosed ? '#00ff00' : '#ffff00') : '#ff0000';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        
        if (i === 0 && screenMouse && !isClosed && points.length > 2) {
          const dist = Math.sqrt(Math.pow(screenMouse.x - p.x, 2) + Math.pow(screenMouse.y - p.y, 2));
          if (dist < 20) {
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      });
      ctx.restore();
    }
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
    if (!image) return;
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
    if (!image) return;
    const p = getCanvasPoint(e);
    setMousePos(p);

    if (dragStartPos.current) {
      const dist = Math.sqrt(
        Math.pow(e.clientX - dragStartPos.current.x, 2) + 
        Math.pow(e.clientY - dragStartPos.current.y, 2)
      );
      if (dist > 5) hasDragged.current = true;
    }

    canvasViewport.updatePanning(e);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!image) return;
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
        const { zoom, offset } = canvasViewport.view;
        const firstPoint = points[0];
        const screenFirst = { x: firstPoint.x * zoom + offset.x, y: firstPoint.y * zoom + offset.y };
        const canvas = canvasRef.current;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const scaleX = canvas.width / rect.width;
          const scaleY = canvas.height / rect.height;
          const screenClick = { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
          const dist = Math.sqrt(Math.pow(screenClick.x - screenFirst.x, 2) + Math.pow(screenClick.y - screenFirst.y, 2));
          if (dist < 20) {
            setIsClosed(true);
            return;
          }
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

  const handleResetCanvas = () => {
    if (image) canvasViewport.fitToView(image.width, image.height);
    else canvasViewport.resetView();
  };

  const handleResetPreview = () => {
    if (previewDimensions.current.w > 0) {
      previewViewport.fitToView(previewDimensions.current.w, previewDimensions.current.h);
    } else {
      previewViewport.resetView();
    }
  };

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <Scissors className="w-8 h-8 text-primary" />
          Lasso Cutout Tool
        </h1>
        <p className="text-muted-foreground">
          Draw precise polygons to extract objects from any image.
        </p>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <Card className="p-4 space-y-4 h-fit">
            <div className="text-xs text-muted-foreground space-y-2">
              <p className="font-semibold text-foreground">Shortcuts:</p>
              <div className="grid grid-cols-2 gap-y-1 border rounded-md p-3 bg-muted/20">
                <span>Finish:</span> <span className="font-mono bg-muted px-1 rounded text-[10px]">Enter</span>
                <span>Undo:</span> <span className="font-mono bg-muted px-1 rounded text-[10px]">Ctrl+Z / Right-Click</span>
                <span>Clear:</span> <span className="font-mono bg-muted px-1 rounded text-[10px]">Space / Esc</span>
                <span>Move:</span> <span className="font-mono bg-muted px-1 rounded text-[10px]">Click & Drag</span>
              </div>
            </div>
          </Card>
        </div>

        <div className="lg:col-span-3 flex flex-col gap-6">
          <Card className="relative overflow-hidden min-h-[600px] flex flex-col border shadow-xl" onContextMenu={(e) => e.preventDefault()}>
            <div className="flex items-center justify-between p-2 bg-muted/30 border-b backdrop-blur-sm z-10">
              <div className="flex items-center gap-1">
                <input type="file" ref={fileInputRef} className="hidden" onChange={handleImageUpload} accept="image/*" />
                <Button variant="outline" size="sm" className="h-8 gap-2" onClick={() => fileInputRef.current?.click()}>
                  <Upload className="h-4 w-4" /> {image ? 'Change' : 'Upload'}
                </Button>
                <div className="w-px h-4 bg-border mx-1" />
                <Button variant={mode === 'lasso' ? 'default' : 'ghost'} size="sm" className="h-8 px-3" onClick={() => setMode('lasso')} title="Lasso Tool"><Scissors className="h-4 w-4 mr-2" /> Lasso</Button>
                <Button variant={mode === 'pan' ? 'default' : 'ghost'} size="sm" className="h-8 px-3" onClick={() => setMode('pan')} title="Pan Tool"><Move className="h-4 w-4 mr-2" /> Pan</Button>
                <div className="w-px h-4 bg-border mx-1" />
                <Button size="icon" variant="ghost" className="h-8 w-8" title="Toggle Grid Color" onClick={() => setGridTheme(prev => prev === 'light' ? 'dark' : 'light')}><Palette className={cn("h-4 w-4", gridTheme === 'dark' ? "text-primary" : "text-muted-foreground")} /></Button>
                <ViewportControls onZoomIn={canvasViewport.setZoomIn} onZoomOut={canvasViewport.setZoomOut} onReset={handleResetCanvas} />
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-8" onClick={undoLastPoint} disabled={points.length === 0}><Undo className="mr-2 h-4 w-4" /> Undo</Button>
                <Button variant="ghost" size="sm" className="h-8 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={clearSelection} disabled={points.length === 0}><Trash2 className="mr-2 h-4 w-4" /> Clear</Button>
              </div>
            </div>

            <div 
              ref={canvasViewport.containerRef}
              className={cn(
                "flex-1 relative overflow-hidden group transition-colors duration-500",
                image ? (gridTheme === 'light' ? "checkerboard-light" : "checkerboard-dark") : "bg-muted/5 hover:bg-muted/10 cursor-pointer"
              )}
              onClick={() => !image && fileInputRef.current?.click()}
            >
              {!image ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground animate-in fade-in zoom-in duration-500">
                  <div className="w-20 h-20 rounded-full bg-primary/5 flex items-center justify-center mb-4 group-hover:scale-110 group-hover:bg-primary/10 transition-all duration-300">
                    <Upload className="h-10 w-10 text-primary/40 group-hover:text-primary transition-colors" />
                  </div>
                  <p className="font-medium text-lg text-foreground/60">Upload an image to start</p>
                  <p className="text-sm opacity-60">or click the button in the toolbar</p>
                </div>
              ) : (
                <canvas
                  ref={canvasRef}
                  width={image.width}
                  height={image.height}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  className={cn(
                    "absolute top-0 left-0 max-w-none max-h-none",
                    mode === 'pan' ? 'cursor-move' : 'cursor-crosshair',
                    canvasViewport.isPanning && 'cursor-grabbing'
                  )}
                />
              )}
              {image && <ZoomIndicator zoom={canvasViewport.view.zoom} className="absolute bottom-4 right-4" />}
            </div>
          </Card>

          {isClosed && (
            <Card className="p-4 space-y-4 animate-in slide-in-from-top-4 duration-500 shadow-md">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2"><Sparkles className="w-5 h-5 text-primary" />Process Selection</CardTitle>
                <Button onClick={() => processCutout()} disabled={isProcessing} className="bg-primary hover:bg-primary/90">
                  {isProcessing ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  {isProcessing ? 'Processing...' : 'Process Cutout'}
                </Button>
              </div>
              <div className="pt-2 border-t border-dashed">
                <BackgroundRemovalSettings state={brState} setState={setBrState} showAdvanced={showAdvancedChroma} setShowAdvanced={setShowAdvancedChroma} compact={true} />
              </div>
            </Card>
          )}

          {previewUrl && (
            <div ref={resultsRef} className="animate-in fade-in slide-in-from-bottom-8 duration-700">
              <Card className="shadow-2xl ring-1 ring-primary/10 overflow-hidden">
                <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0 bg-muted/20 border-b">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg">Final Result</CardTitle>
                    <Button size="icon" variant="ghost" className="h-7 w-7" title="Toggle Grid" onClick={() => setGridTheme(prev => prev === 'light' ? 'dark' : 'light')}><Palette className={cn("h-4 w-4", gridTheme === 'dark' ? "text-primary" : "text-muted-foreground")} /></Button>
                  </div>
                  <div className="flex gap-1 items-center">
                    <ViewportControls onZoomIn={previewViewport.setZoomIn} onZoomOut={previewViewport.setZoomOut} onReset={handleResetPreview} />
                    <div className="w-px h-4 bg-border mx-1" />
                    <Button onClick={exportClippedImage} size="sm" className="h-8 gap-2"><Download className="h-4 w-4" /> Export</Button>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div
                    ref={previewViewport.containerRef}
                    className={cn(
                      "aspect-square min-h-[400px] overflow-hidden relative cursor-move touch-none bg-muted/5",
                      gridTheme === 'light' ? "checkerboard-light" : "checkerboard-dark"
                    )}
                    onMouseDown={previewViewport.startPanning}
                    onMouseMove={previewViewport.updatePanning}
                    onMouseUp={previewViewport.stopPanning}
                    onMouseLeave={previewViewport.stopPanning}
                  >
                    <img src={previewUrl} alt="Result" className="absolute top-0 left-0 shadow-2xl max-w-none" style={{ transform: `translate(${previewViewport.view.offset.x}px, ${previewViewport.view.offset.y}px) scale(${previewViewport.view.zoom})`, transformOrigin: '0 0' }} draggable={false} />
                    <ZoomIndicator zoom={previewViewport.view.zoom} className="absolute bottom-4 right-4" />
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
