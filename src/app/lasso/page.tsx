'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Upload, Download, Trash2, ZoomIn, ZoomOut, Move, Scissors, Undo, RefreshCw, ChevronDown, Sparkles, Maximize, Palette } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface Point {
  x: number;
  y: number;
}

export default function LassoPage() {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [mode, setMode] = useState<'lasso' | 'pan'>('lasso');
  const [mousePos, setMousePos] = useState<Point | null>(null);
  const [isClosed, setIsClosed] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [lastClickTime, setLastClickTime] = useState(0);

  // Preview Zoom/Pan State
  const [pZoom, setPZoom] = useState(1);
  const [pOffset, setPOffset] = useState({ x: 0, y: 0 });
  const [isPanningPreview, setIsPanningPreview] = useState(false);
  const [gridTheme, setGridTheme] = useState<'light' | 'dark'>('light');

  // Background Removal Settings
  const [removeBackground, setRemoveBackground] = useState(false);
  const [autoCrop, setAutoCrop] = useState(true);
  const [showAdvancedChroma, setShowAdvancedChroma] = useState(false);
  const [similarity, setSimilarity] = useState(30);
  const [softness, setSoftness] = useState(10);
  const [spill, setSpill] = useState(20);
  const [choke, setChoke] = useState(1);
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
          setZoom(1);
          setOffset({ x: 0, y: 0 });
          setIsClosed(false);
          setPreviewUrl(null);
        };
        img.src = event.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  };

  const getSampledColor = useCallback(() => {
    if (!image) return { r: 255, g: 255, b: 255 };
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { r: 255, g: 255, b: 255 };
    ctx.drawImage(image, 0, 0);
    
    let samples: Uint8ClampedArray[] = [];
    
    if (points.length > 0) {
      // Sample colors along the polygon vertices to match the immediate surroundings
      points.forEach(p => {
        const x = Math.max(0, Math.min(image.width - 1, Math.round(p.x)));
        const y = Math.max(0, Math.min(image.height - 1, Math.round(p.y)));
        samples.push(ctx.getImageData(x, y, 1, 1).data);
      });
    } else {
      // Fallback to corners if no points placed yet
      samples = [
        ctx.getImageData(0, 0, 1, 1).data,
        ctx.getImageData(image.width - 1, 0, 1, 1).data,
        ctx.getImageData(0, image.height - 1, 1, 1).data,
        ctx.getImageData(image.width - 1, image.height - 1, 1, 1).data
      ];
    }
    
    const r = Math.round(samples.reduce((acc, c) => acc + c[0], 0) / samples.length);
    const g = Math.round(samples.reduce((acc, c) => acc + c[1], 0) / samples.length);
    const b = Math.round(samples.reduce((acc, c) => acc + c[2], 0) / samples.length);
    
    return { r, g, b };
  }, [image, points]);

  const applyChromaKey = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const target = getSampledColor();
    const targetR = target.r, targetG = target.g, targetB = target.b;

    for (let j = 0; j < data.length; j += 4) {
      const r = data[j], g = data[j + 1], b = data[j + 2];
      const dist = Math.sqrt(
        Math.pow(r - targetR, 2) + Math.pow(g - targetG, 2) + Math.pow(b - targetB, 2)
      );
      if (dist < similarity) data[j + 3] = 0;
      else if (dist < similarity + softness) {
        data[j + 3] = Math.min(data[j + 3], ((dist - similarity) / softness) * 255);
      }
      if (dist < similarity + softness + spill) {
        const sf = 1 - Math.max(0, Math.min(1, (dist - similarity) / (softness + spill)));
        const gray = (r + g + b) / 3;
        data[j] = r * (1 - sf) + gray * sf;
        data[j + 1] = g * (1 - sf) + gray * sf;
        data[j + 2] = b * (1 - sf) + gray * sf;
      }
    }

    if (choke > 0) {
      const originalAlphas = new Uint8Array(data.length / 4);
      for (let k = 0; k < originalAlphas.length; k++) originalAlphas[k] = data[k * 4 + 3];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          if (data[idx + 3] === 0) continue;
          let minAlpha = data[idx + 3];
          for (let dy = -choke; dy <= choke; dy++) {
            for (let dx = -choke; dx <= choke; dx++) {
              const ny = y + dy, nx = x + dx;
              if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                const nAlpha = originalAlphas[ny * width + nx];
                if (nAlpha < minAlpha) minAlpha = nAlpha;
              }
            }
          }
          data[idx + 3] = minAlpha;
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);
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

    if (!removeBackground) {
      const sampled = getSampledColor();
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

    if (removeBackground) applyChromaKey(ctx, width, height);

    if (autoCrop) {
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
  }, [image, points, removeBackground, autoCrop, similarity, softness, spill, choke, getSampledColor]);

  const processCutout = async () => {
    setIsProcessing(true);
    await new Promise(r => setTimeout(r, 400));
    const canvas = generateProcessedCanvas();
    if (canvas) {
      setPreviewUrl(canvas.toDataURL('image/png'));
      toast.success('Cutout processed!');
      setPZoom(1);
      setPOffset({ x: 0, y: 0 });
    }
    setIsProcessing(false);
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
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

    if (points.length > 0) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      
      if (isClosed) {
        ctx.closePath();
        ctx.strokeStyle = '#00ff00';
        ctx.fillStyle = 'rgba(0, 255, 0, 0.2)';
        ctx.lineWidth = 2 / zoom;
        ctx.fill();
        ctx.stroke();
      } else if (mode === 'lasso') {
        if (mousePos) ctx.lineTo(mousePos.x, mousePos.y);
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 2 / zoom;
        ctx.setLineDash([5 / zoom, 5 / zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      points.forEach((p, i) => {
        ctx.fillStyle = i === 0 ? (isClosed ? '#00ff00' : '#ffff00') : '#ff0000';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 / zoom, 0, Math.PI * 2);
        ctx.fill();
        
        if (i === 0 && mousePos && !isClosed && points.length > 2) {
          const dist = Math.sqrt(Math.pow(mousePos.x - p.x, 2) + Math.pow(mousePos.y - p.y, 2));
          if (dist < 20 / zoom) {
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 3 / zoom;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 15 / zoom, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      });
    }
    ctx.restore();
  }, [image, points, zoom, offset, mode, mousePos, isClosed]);

  useEffect(() => { draw(); }, [draw]);

  const getCanvasPoint = (e: React.MouseEvent | React.WheelEvent | WheelEvent): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: ((e.clientX - rect.left) * scaleX - offset.x) / zoom,
      y: ((e.clientY - rect.top) * scaleY - offset.y) / zoom
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

    if (mode === 'pan' || (e.button === 1)) {
      setIsPanning(true);
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        setPanStart({ 
          x: (e.clientX - rect.left) * scaleX - offset.x, 
          y: (e.clientY - rect.top) * scaleY - offset.y 
        });
      }
    } else if (mode === 'lasso' && image && !isClosed) {
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
        if (dist < 20 / zoom) {
          setIsClosed(true);
          return;
        }
      }
      setPoints([...points, p]);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const p = getCanvasPoint(e);
    setMousePos(p);
    if (isPanning) {
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        setOffset({
          x: (e.clientX - rect.left) * scaleX - panStart.x,
          y: (e.clientY - rect.top) * scaleY - panStart.y
        });
      }
    }
  };

  const handleMouseUp = () => setIsPanning(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheelRaw = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.min(Math.max(zoom * delta, 0.1), 10);
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const mouseX = (e.clientX - rect.left) * scaleX;
      const mouseY = (e.clientY - rect.top) * scaleY;
      setZoom(newZoom);
      setOffset({
        x: mouseX - (mouseX - offset.x) * (newZoom / zoom),
        y: mouseY - (mouseY - offset.y) * (newZoom / zoom)
      });
    };

    const preventDefault = (e: Event) => e.preventDefault();
    canvas.addEventListener('wheel', handleWheelRaw, { passive: false });
    canvas.addEventListener('gesturestart', preventDefault, { passive: false });
    canvas.addEventListener('gesturechange', preventDefault, { passive: false });

    return () => {
      canvas.removeEventListener('wheel', handleWheelRaw);
      canvas.removeEventListener('gesturestart', preventDefault);
      canvas.removeEventListener('gesturechange', preventDefault);
    };
  }, [zoom, offset, image]);

  useEffect(() => {
    const container = previewContainerRef.current;
    if (!container) return;

    const handleWheelRaw = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.min(Math.max(pZoom * delta, 0.1), 10);
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      setPZoom(newZoom);
      setPOffset({
        x: mouseX - (mouseX - pOffset.x) * (newZoom / pZoom),
        y: mouseY - (mouseY - pOffset.y) * (newZoom / pZoom)
      });
    };

    const preventDefault = (e: Event) => e.preventDefault();
    container.addEventListener('wheel', handleWheelRaw, { passive: false });
    container.addEventListener('gesturestart', preventDefault, { passive: false });
    container.addEventListener('gesturechange', preventDefault, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheelRaw);
      container.removeEventListener('gesturestart', preventDefault);
      container.removeEventListener('gesturechange', preventDefault);
    };
  }, [pZoom, pOffset]);

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

  const resetView = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
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
                <span>Move:</span> <span className="font-mono bg-muted px-1 rounded text-[10px]">Middle-Click</span>
              </div>
            </div>
          </Card>
        </div>

        <div className="lg:col-span-3 flex flex-col gap-6">
          <Card className="relative overflow-hidden min-h-[600px] flex flex-col border shadow-lg" onContextMenu={(e) => e.preventDefault()}>
            {/* Toolbar */}
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
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom(z => z * 1.1)} title="Zoom In">
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom(z => z * 0.9)} title="Zoom Out">
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={resetView} title="Reset View">
                  <RefreshCw className="h-4 w-4" />
                </Button>
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

            {/* Canvas Container */}
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
                className={`max-w-full max-h-full object-contain ${mode === 'pan' ? 'cursor-move' : 'cursor-crosshair'}`}
              />
            </div>
          </Card>

          {isClosed && (
            <Card className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-primary" />
                  Process Selection
                </CardTitle>
                <Button onClick={processCutout} disabled={isProcessing} className="bg-primary hover:bg-primary/90">
                  {isProcessing ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  {isProcessing ? 'Processing...' : 'Process Cutout'}
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 pt-2 border-t border-dashed">
                <div className="flex items-center justify-between space-x-2">
                  <Label className="text-xs">Remove Background</Label>
                  <Switch checked={removeBackground} onCheckedChange={setRemoveBackground} className="scale-75" />
                </div>

                <div className="flex items-center justify-between space-x-2">
                  <Label className="text-xs">Tight Bounding Box</Label>
                  <Switch checked={autoCrop} onCheckedChange={setAutoCrop} className="scale-75" />
                </div>

                {removeBackground && (
                  <div className="lg:col-span-2 space-y-3">
                    <button onClick={() => setShowAdvancedChroma(!showAdvancedChroma)} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
                      <ChevronDown className={cn("w-3 h-3 transition-transform", showAdvancedChroma && "rotate-180")} />
                      Advanced Chroma Key Settings
                    </button>
                    {showAdvancedChroma && (
                      <div className="grid grid-cols-2 gap-x-6 gap-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
                        {[
                          { label: "Similarity", val: similarity, set: setSimilarity, max: 150 },
                          { label: "Softness", val: softness, set: setSoftness, max: 50 },
                          { label: "Spill", val: spill, set: setSpill, max: 100 },
                          { label: "Choke", val: choke, set: setChoke, max: 5 },
                        ].map((s) => (
                          <div key={s.label} className="space-y-1">
                            <div className="flex justify-between text-[10px]">
                              <span>{s.label}</span>
                              <span className="font-mono">{s.val}</span>
                            </div>
                            <Slider value={[s.val]} min={0} max={s.max} step={1} onValueChange={(v) => s.set(v[0])} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
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
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setPZoom(prev => Math.max(0.1, prev - 0.2))}
                  >
                    <ZoomOut className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => { setPZoom(1); setPOffset({ x: 0, y: 0 }); }}
                  >
                    <Maximize className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setPZoom(prev => Math.min(10, prev + 0.2))}
                  >
                    <ZoomIn className="h-4 w-4" />
                  </Button>
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
                    removeBackground && (gridTheme === 'light' ? "checkerboard-light" : "checkerboard-dark")
                  )}
                  onMouseDown={() => setIsPanningPreview(true)}
                  onMouseMove={(e) => {
                    if (!isPanningPreview) return;
                    setPOffset(prev => ({
                      x: prev.x + e.movementX / pZoom,
                      y: prev.y + e.movementY / pZoom
                    }));
                  }}
                  onMouseUp={() => setIsPanningPreview(false)}
                  onMouseLeave={() => setIsPanningPreview(false)}
                >
                  <img
                    src={previewUrl}
                    alt="Cutout Preview"
                    className="object-contain transition-transform duration-200"
                    style={{
                      transform: `scale(${pZoom}) translate(${pOffset.x}px, ${pOffset.y}px)`,
                    }}
                    draggable={false}
                  />
                  <div className="absolute bottom-4 right-4 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full font-mono">
                    Zoom: {Math.round(pZoom * 100)}%
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
