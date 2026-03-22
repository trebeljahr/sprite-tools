"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import {
  Upload,
  Scissors,
  LayoutGrid,
  Download,
  Loader2,
  Play,
  Pause,
  RefreshCw,
  Video as VideoIcon,
  ImageIcon,
  MonitorPlay,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export default function SpritesheetPage() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [frames, setFrames] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fps, setFps] = useState(10);
  const [columns, setColumns] = useState(8);
  const [spritesheetUrl, setSpritesheetUrl] = useState<string | null>(null);

  // Background Removal
  const [removeBackground, setRemoveBackground] = useState(false);
  const [similarity, setSimilarity] = useState(30);

  // Animation Preview State
  const [previewIndex, setPreviewIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playbackRef = useRef<NodeJS.Timeout | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVideoFile(file);
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
      setFrames([]);
      setSpritesheetUrl(null);
      setPreviewIndex(0);
      setIsPlaying(false);
    }
  };

  const extractFrames = async () => {
    if (!videoUrl) return;

    setIsProcessing(true);
    setProgress(0);
    setFrames([]);
    setSpritesheetUrl(null);
    setIsPlaying(false);

    const video = document.createElement("video");
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;

    await new Promise((resolve) => {
      video.onloadedmetadata = resolve;
    });

    const duration = video.duration;
    const totalFrames = Math.floor(duration * fps);
    const frameInterval = 1 / fps;
    const extracted: string[] = [];

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    for (let i = 0; i < totalFrames; i++) {
      const time = i * frameInterval;
      video.currentTime = time;

      await new Promise((resolve) => {
        video.onseeked = resolve;
      });

      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        if (removeBackground) {
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;

          // Sample all four corners for more robust chroma keying
          const corners = [
            { r: data[0], g: data[1], b: data[2] }, // Top-left
            {
              r: data[(canvas.width - 1) * 4],
              g: data[(canvas.width - 1) * 4 + 1],
              b: data[(canvas.width - 1) * 4 + 2],
            }, // Top-right
            {
              r: data[data.length - canvas.width * 4],
              g: data[data.length - canvas.width * 4 + 1],
              b: data[data.length - canvas.width * 4 + 2],
            }, // Bottom-left
            {
              r: data[data.length - 4],
              g: data[data.length - 3],
              b: data[data.length - 2],
            }, // Bottom-right
          ];

          // Pick the most common color among corners to be the target chroma color
          const colorCounts: Record<
            string,
            { r: number; g: number; b: number; count: number }
          > = {};
          corners.forEach((c) => {
            const key = `${c.r},${c.g},${c.b}`;
            if (colorCounts[key]) colorCounts[key].count++;
            else colorCounts[key] = { ...c, count: 1 };
          });

          let target = corners[0];
          let maxCount = 0;
          for (const key in colorCounts) {
            if (colorCounts[key].count > maxCount) {
              maxCount = colorCounts[key].count;
              target = colorCounts[key];
            }
          }

          const targetR = target.r;
          const targetG = target.g;
          const targetB = target.b;

          for (let j = 0; j < data.length; j += 4) {
            const r = data[j];
            const g = data[j + 1];
            const b = data[j + 2];

            // Euclidean distance for color similarity
            const distance = Math.sqrt(
              Math.pow(r - targetR, 2) +
                Math.pow(g - targetG, 2) +
                Math.pow(b - targetB, 2),
            );

            if (distance < similarity) {
              data[j + 3] = 0; // Set alpha to 0 (transparent)
            }
          }
          ctx.putImageData(imageData, 0, 0);
        }

        extracted.push(canvas.toDataURL("image/png"));
      }

      setProgress(Math.round(((i + 1) / totalFrames) * 100));
    }

    setFrames(extracted);
    setIsProcessing(false);
    toast.success(`Extracted ${extracted.length} frames!`);
  };

  const generateSpritesheet = () => {
    if (frames.length === 0) return;

    const img = new Image();
    img.src = frames[0];
    img.onload = () => {
      const frameWidth = img.width;
      const frameHeight = img.height;
      const totalFrames = frames.length;
      const rows = Math.ceil(totalFrames / columns);

      const canvas = document.createElement("canvas");
      canvas.width = columns * frameWidth;
      canvas.height = rows * frameHeight;
      const ctx = canvas.getContext("2d");

      if (!ctx) return;

      let loadedCount = 0;
      frames.forEach((frameData, index) => {
        const frameImg = new Image();
        frameImg.src = frameData;
        frameImg.onload = () => {
          const col = index % columns;
          const row = Math.floor(index / columns);
          ctx.drawImage(frameImg, col * frameWidth, row * frameHeight);

          loadedCount++;
          if (loadedCount === totalFrames) {
            setSpritesheetUrl(canvas.toDataURL("image/png"));
            toast.success("Sprite sheet generated!");
          }
        };
      });
    };
  };

  // Playback logic
  useEffect(() => {
    if (isPlaying && frames.length > 0) {
      playbackRef.current = setInterval(() => {
        setPreviewIndex((prev) => (prev + 1) % frames.length);
      }, 1000 / fps);
    } else {
      if (playbackRef.current) clearInterval(playbackRef.current);
    }
    return () => {
      if (playbackRef.current) clearInterval(playbackRef.current);
    };
  }, [isPlaying, frames.length, fps]);

  const downloadSpritesheet = () => {
    if (!spritesheetUrl) return;
    const link = document.createElement("a");
    link.href = spritesheetUrl;
    link.download = "spritesheet.png";
    link.click();
  };

  return (
    <main className="flex-1 container max-w-6xl mx-auto py-12 px-4">
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <Scissors className="w-8 h-8 text-primary" />
          Video to Sprite Sheet
        </h1>
        <p className="text-muted-foreground">
          Extract frames from your video and stitch them into a professional
          animation sprite sheet.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Settings Column */}
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
              <CardDescription>
                Configure extraction and grid layout.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="video-upload">Video Source</Label>
                <div
                  className={cn(
                    "border-2 border-dashed rounded-lg overflow-hidden flex flex-col items-center justify-center cursor-pointer transition-colors relative",
                    videoUrl
                      ? "border-primary/50 aspect-video"
                      : "border-muted-foreground/20 hover:border-primary/50 p-6",
                  )}
                  onClick={() =>
                    !videoUrl &&
                    document.getElementById("video-upload")?.click()
                  }
                >
                  {videoUrl ? (
                    <>
                      <video
                        src={videoUrl}
                        className="w-full h-full object-cover"
                        muted
                        loop
                        autoPlay
                      />
                      <div
                        className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          document.getElementById("video-upload")?.click();
                        }}
                      >
                        <div className="text-center">
                          <RefreshCw className="w-8 h-8 text-white mx-auto mb-2" />
                          <p className="text-white text-sm font-medium">
                            Change Video
                          </p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <Upload className="w-8 h-8 text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">
                        Upload MP4 or WebM
                      </p>
                    </>
                  )}
                  <Input
                    id="video-upload"
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <Label>Extraction FPS</Label>
                    <span className="text-sm font-medium bg-muted px-2 py-0.5 rounded">
                      {fps || 10}
                    </span>
                  </div>
                  <div className="px-1">
                    <Slider
                      className="w-full"
                      value={[fps]}
                      min={1}
                      max={60}
                      step={1}
                      onValueChange={(val) => {
                        if (typeof val === "number") setFps(val);
                        else if (val && val.length > 0) {
                          setFps(val[0]);
                        }
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    How many frames to grab per second of video.
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between">
                    <Label>Grid Columns</Label>
                    <span className="text-sm font-medium bg-muted px-2 py-0.5 rounded">
                      {columns || 8}
                    </span>
                  </div>
                  <div className="px-1">
                    <Slider
                      className="w-full"
                      value={[columns]}
                      min={1}
                      max={20}
                      step={1}
                      onValueChange={(val) => {
                        if (typeof val === "number") setColumns(val);
                        else if (val && val.length > 0) {
                          setColumns(val[0]);
                        }
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Number of columns in the final sprite sheet.
                  </p>
                </div>

                <div className="pt-4 border-t space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Remove Background</Label>
                      <p className="text-xs text-muted-foreground">
                        Auto-remove chroma color (samples top-left pixel).
                      </p>
                    </div>
                    <Switch
                      checked={removeBackground}
                      onCheckedChange={setRemoveBackground}
                    />
                  </div>

                  {removeBackground && (
                    <div className="space-y-3">
                      <div className="flex justify-between">
                        <Label className="text-xs">Chroma Similarity</Label>
                        <span className="text-[10px] font-mono">
                          {similarity || 30}
                        </span>
                      </div>
                      <div className="px-1">
                        <Slider
                          className="w-full"
                          value={[similarity]}
                          min={1}
                          max={150}
                          step={1}
                          onValueChange={(val) => {
                            if (typeof val === "number") setSimilarity(val);
                            else if (val && val.length > 0) {
                              setSimilarity(val[0]);
                            }
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
            <CardFooter className="flex flex-col gap-3">
              <Button
                onClick={extractFrames}
                disabled={isProcessing || !videoUrl}
                className="w-full"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Extracting... {progress}%
                  </>
                ) : (
                  <>
                    <Scissors className="mr-2 h-4 w-4" />
                    Extract Frames
                  </>
                )}
              </Button>

              <Button
                onClick={generateSpritesheet}
                disabled={isProcessing || frames.length === 0}
                variant="secondary"
                className="w-full"
              >
                <LayoutGrid className="mr-2 h-4 w-4" />
                Generate Sheet
              </Button>
            </CardFooter>
          </Card>

          {isProcessing && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span>Processing frames...</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          )}
        </div>

        {/* Results Column */}
        <div className="lg:col-span-8 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Animation Preview Card */}
            <Card className="md:col-span-1">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <MonitorPlay className="w-4 h-4" />
                  Animation Preview
                </CardTitle>
                <CardDescription>
                  Scrub or play back extracted frames.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="aspect-square rounded-lg bg-muted/30 border flex items-center justify-center overflow-hidden relative">
                  {frames.length > 0 ? (
                    <img
                      src={frames[previewIndex]}
                      alt="Preview frame"
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="text-center p-6 text-muted-foreground text-sm">
                      No frames extracted yet.
                    </div>
                  )}
                  {frames.length > 0 && (
                    <div className="absolute bottom-2 right-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-mono">
                      {previewIndex + 1} / {frames.length}
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() => setIsPlaying(!isPlaying)}
                      disabled={frames.length === 0}
                    >
                      {isPlaying ? (
                        <Pause className="w-4 h-4" />
                      ) : (
                        <Play className="w-4 h-4" />
                      )}
                    </Button>
                    <div className="flex-1 px-1">
                      <Slider
                        className="w-full"
                        value={[previewIndex]}
                        min={0}
                        max={Math.max(0, frames.length - 1)}
                        step={1}
                        onValueChange={(val) => {
                          if (typeof val === "number") setPreviewIndex(val);
                          else if (val && val.length > 0) {
                            setPreviewIndex(val[0]);
                          }

                          setIsPlaying(false);
                        }}
                      />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Sprite Sheet Result */}
            <Card
              className={cn("md:col-span-1", !spritesheetUrl && "opacity-50")}
            >
              <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-lg">Sprite Sheet</CardTitle>
                {spritesheetUrl && (
                  <Button
                    onClick={downloadSpritesheet}
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                <div className="aspect-square rounded-lg bg-muted/30 border flex items-center justify-center overflow-hidden">
                  {spritesheetUrl ? (
                    <img
                      src={spritesheetUrl}
                      alt="Sprite Sheet"
                      className="w-full h-full object-contain cursor-zoom-in"
                      onClick={downloadSpritesheet}
                    />
                  ) : (
                    <div className="text-center p-6 text-muted-foreground text-sm">
                      Generate a sheet to preview it here.
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Frames Preview */}
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Extracted Frames ({frames.length})</CardTitle>
                <CardDescription>
                  Click on a frame to set it as the preview start.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {frames.length > 0 ? (
                <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2 max-h-[300px] overflow-y-auto p-1 border rounded-md">
                  {frames.map((frame, i) => (
                    <div
                      key={i}
                      className={cn(
                        "aspect-square border rounded bg-muted/50 overflow-hidden group relative cursor-pointer transition-all hover:ring-2 hover:ring-primary/50",
                        previewIndex === i && "ring-2 ring-primary",
                      )}
                      onClick={() => {
                        setPreviewIndex(i);
                        setIsPlaying(false);
                      }}
                    >
                      <img
                        src={frame}
                        alt={`Frame ${i}`}
                        className="w-full h-full object-contain"
                      />
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <span className="text-[10px] text-white font-mono">
                          #{i}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 border-2 border-dashed rounded-lg border-muted-foreground/10 bg-muted/5">
                  <ImageIcon className="w-12 h-12 text-muted-foreground/20 mx-auto mb-4" />
                  <p className="text-muted-foreground text-sm">
                    Stills will appear here after extraction.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
