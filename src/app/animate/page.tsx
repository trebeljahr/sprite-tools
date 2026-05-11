"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Upload, Video, Loader2, Play, RefreshCw, Scissors } from "lucide-react";
import { cn } from "@/lib/utils";

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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { generateVideoAction, checkStatusAction } from "../actions";
import { AuthWall } from "@/components/auth-wall";
import { AiGate } from "@/components/ai-gate";
import Link from "next/link";

function HomeContent() {
  const searchParams = useSearchParams();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState<string | null>("1");
  const [resolution, setResolution] = useState<string | null>("720p");
  const [aspectRatio, setAspectRatio] = useState<string | null>("16:9");

  const [isGenerating, setIsGenerating] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_requestId, setRequestId] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const pollInterval = useRef<NodeJS.Timeout | null>(null);

  const handleLoadFromUrl = async (url: string) => {
    try {
      setStatus("Loading image from designer...");
      const response = await fetch(url);
      const blob = await response.blob();
      const fileName = "generated-sprite.png";
      const loadedFile = new File([blob], fileName, { type: "image/png" });
      setFile(loadedFile);
      setPreview(url);
      toast.success("Image loaded from Step 1!");
    } catch (error) {
      console.error("Error loading image from URL:", error);
      toast.error("Failed to load image from Step 1.");
    } finally {
      setStatus(null);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: handleLoadFromUrl is stable; effect should only run on searchParams change
  useEffect(() => {
    const imageUrl = searchParams.get("imageUrl");
    if (imageUrl) {
      handleLoadFromUrl(imageUrl);
    }
  }, [searchParams]);

  const [isDragging, setIsDragging] = useState(false);

  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Unsupported file type. Please upload an image.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File size must be less than 10MB");
      return;
    }
    setFile(file);
    const url = URL.createObjectURL(file);
    setPreview(url);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) handleFile(selectedFile);
  };

  // Global Paste Support
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const item = e.clipboardData?.items[0];
      if (item?.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) handleFile(file);
      }
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
    // biome-ignore lint/correctness/useExhaustiveDependencies: handleFile is recreated each render but only closes over stable setters; rebinding listener is intentional
  }, [handleFile]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !prompt) {
      toast.error("Please provide both an image and a prompt.");
      return;
    }

    setIsGenerating(true);
    setVideoUrl(null);
    setStatus("Initiating generation...");

    const formData = new FormData();
    formData.append("image", file);
    formData.append("prompt", prompt);
    formData.append("duration", duration!);
    formData.append("resolution", resolution!);
    formData.append("aspect_ratio", aspectRatio!);

    const result = await generateVideoAction(formData);

    if (result.success && result.id) {
      setRequestId(result.id);
      setStatus("Processing video...");
      startPolling(result.id);
    } else {
      setIsGenerating(false);
      toast.error(result.error || "Failed to start generation");
    }
  };

  const startPolling = (id: string) => {
    if (pollInterval.current) clearInterval(pollInterval.current);

    pollInterval.current = setInterval(async () => {
      const result = await checkStatusAction(id);

      if (result.success && result.data) {
        const { status: currentStatus, video } = result.data;
        const video_url = video?.url;

        setStatus(`Status: ${currentStatus}`);

        if (currentStatus === "done" && video_url) {
          setVideoUrl(video_url);
          setIsGenerating(false);
          clearInterval(pollInterval.current!);
          toast.success("Video generated successfully!");
        } else if (currentStatus === "failed") {
          setIsGenerating(false);
          clearInterval(pollInterval.current!);
          toast.error("Video generation failed.");
        }
      } else {
        setIsGenerating(false);
        clearInterval(pollInterval.current!);
        toast.error(result.error || "Polling failed");
      }
    }, 3000);
  };

  useEffect(() => {
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, []);

  return (
    <main className="flex-1 container max-w-6xl mx-auto py-8 px-4">
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <Video className="w-8 h-8 text-primary" />
          AI Animation
        </h1>
        <p className="text-muted-foreground">Animate a character sprite with xAI Grok Imagine.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Input Column */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Configure Animation</CardTitle>
              <CardDescription>Set the motion prompt for your character.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleGenerate} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="image">Source Image</Label>
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: container intercepts events; not a control */}
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: file drop zone — click forwards to nested <input type="file">; keyboard a11y tracked separately */}
                  <div
                    className={cn(
                      "border-2 border-dashed rounded-lg p-6 flex flex-col items-center justify-center cursor-pointer transition-all",
                      preview
                        ? "border-primary/50"
                        : "border-muted-foreground/20 hover:border-primary/50",
                      isDragging && "ring-4 ring-primary ring-inset bg-primary/5 border-primary/50",
                    )}
                    onClick={() => document.getElementById("image")?.click()}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    {preview ? (
                      <div className="relative w-full aspect-video">
                        <img
                          src={preview}
                          alt="Preview"
                          className="rounded object-cover w-full h-full"
                        />
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
                          <p className="text-white text-sm font-medium">Change Image</p>
                        </div>
                      </div>
                    ) : (
                      <>
                        <Upload className="w-10 h-10 text-muted-foreground mb-2" />
                        <p className="text-sm text-muted-foreground">Click or drag to upload</p>
                      </>
                    )}
                    <Input
                      id="image"
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleFileChange}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="prompt">Motion Prompt</Label>
                  <Textarea
                    id="prompt"
                    placeholder="Describe the motion (e.g., walking, swinging sword, idle breathing...)"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className="h-24"
                  />
                  <p className="text-xs text-muted-foreground">
                    Focus on movement. The image is the starting point.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div className="space-y-2">
                    <Label>Duration</Label>
                    <Select value={duration || "1"} onValueChange={setDuration}>
                      <SelectTrigger>
                        <SelectValue placeholder="1s" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1 second</SelectItem>
                        <SelectItem value="2">2 seconds</SelectItem>
                        <SelectItem value="3">3 seconds</SelectItem>
                        <SelectItem value="5">5 seconds</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Resolution</Label>
                    <Select value={resolution || "720p"} onValueChange={setResolution}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="720p">720p</SelectItem>
                        <SelectItem value="480p">480p</SelectItem>
                        <SelectItem value="1080p">1080p</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Aspect Ratio</Label>
                  <Select value={aspectRatio || "16:9"} onValueChange={setAspectRatio}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="16:9">16:9 (Widescreen)</SelectItem>
                      <SelectItem value="9:16">9:16 (Portrait)</SelectItem>
                      <SelectItem value="1:1">1:1 (Square)</SelectItem>
                      <SelectItem value="4:3">4:3 (Classic)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </form>
            </CardContent>
            <CardFooter>
              <Button
                onClick={handleGenerate}
                disabled={isGenerating || !file || !prompt}
                className="w-full"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Generating Video...
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    Animate Character
                  </>
                )}
              </Button>
            </CardFooter>
          </Card>
        </div>

        {/* Output Column */}
        <div className="space-y-6">
          <Card className="h-full flex flex-col">
            <CardHeader>
              <CardTitle>Resulting Animation</CardTitle>
              <CardDescription>Your animated character clip will appear here.</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex items-center justify-center">
              {videoUrl ? (
                <div className="w-full space-y-4">
                  <video
                    src={videoUrl}
                    controls
                    autoPlay
                    loop
                    className="w-full rounded-lg shadow-lg border"
                  />
                  <div className="flex flex-col gap-2">
                    <Link
                      href={`/spritesheet?videoUrl=${encodeURIComponent(videoUrl)}`}
                      className="inline-flex items-center justify-center rounded-lg h-10 px-4 bg-primary text-primary-foreground hover:bg-primary/90 font-medium transition-colors w-full"
                    >
                      <Scissors className="mr-2 h-4 w-4" />
                      Go to Step 3: Extract Spritesheet
                    </Link>
                    <Button variant="outline" onClick={() => setVideoUrl(null)}>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Create New Animation
                    </Button>
                  </div>
                </div>
              ) : isGenerating ? (
                <div className="text-center space-y-4">
                  <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto" />
                  <div className="space-y-1">
                    <p className="font-medium">{status}</p>
                    <p className="text-xs text-muted-foreground italic">
                      Generating a video takes about 30-60 seconds...
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-center p-12 border-2 border-dashed rounded-lg border-muted-foreground/10 bg-muted/5">
                  <Video className="w-12 h-12 text-muted-foreground/20 mx-auto mb-4" />
                  <p className="text-muted-foreground text-sm">
                    No video generated yet. Fill out the form to get started.
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

export default function AnimatePage() {
  return (
    <AiGate
      feature="AI Animation"
      description="Turn a character image into a short animation using xAI Grok Imagine video generation."
    >
      <AuthWall
        feature="AI Animation"
        description="Turn a character image into a short animation using xAI Grok Imagine video generation."
        costHint="~1 credit per animation"
      >
        <Suspense
          fallback={<div className="flex items-center justify-center min-h-screen">Loading…</div>}
        >
          <HomeContent />
        </Suspense>
      </AuthWall>
    </AiGate>
  );
}
