"use client";

import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Upload, Video, Loader2, Play, RefreshCw } from "lucide-react";

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

import { generateVideoAction, checkStatusAction } from "./actions";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState<string | null>("1");
  const [resolution, setResolution] = useState<string | null>("720p");
  const [aspectRatio, setAspectRatio] = useState<string | null>("16:9");

  const [isGenerating, setIsGenerating] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const pollInterval = useRef<NodeJS.Timeout | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (selectedFile.size > 10 * 1024 * 1024) {
        toast.error("File size must be less than 10MB");
        return;
      }
      setFile(selectedFile);
      const url = URL.createObjectURL(selectedFile);
      setPreview(url);
    }
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
        const { status: currentStatus, video_url } = result.data;
        setStatus(`Status: ${currentStatus}`);

        if (currentStatus === "completed" && video_url) {
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
    <main className="flex-1 container max-w-4xl mx-auto py-12 px-4">
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <Video className="w-8 h-8 text-primary" />
          Grok Imagine Video
        </h1>
        <p className="text-muted-foreground">
          Turn any image into a cinematic 1-second video with the power of Grok
          AI.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Input Column */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Configure</CardTitle>
              <CardDescription>
                Upload your image and set the prompt.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleGenerate} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="image">Source Image</Label>
                  <div
                    className={`border-2 border-dashed rounded-lg p-6 flex flex-col items-center justify-center cursor-pointer transition-colors ${preview ? "border-primary/50" : "border-muted-foreground/20 hover:border-primary/50"}`}
                    onClick={() => document.getElementById("image")?.click()}
                  >
                    {preview ? (
                      <div className="relative w-full aspect-video">
                        <img
                          src={preview}
                          alt="Preview"
                          className="rounded object-cover w-full h-full"
                        />
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
                          <p className="text-white text-sm font-medium">
                            Change Image
                          </p>
                        </div>
                      </div>
                    ) : (
                      <>
                        <Upload className="w-10 h-10 text-muted-foreground mb-2" />
                        <p className="text-sm text-muted-foreground">
                          Click or drag to upload
                        </p>
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
                  <Label htmlFor="prompt">Prompt</Label>
                  <Textarea
                    id="prompt"
                    placeholder="Describe the motion (e.g., cinematic zoom, gentle breeze...)"
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
                    <Select value={duration} onValueChange={setDuration}>
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
                    <Select value={resolution} onValueChange={setResolution}>
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
                  <Select value={aspectRatio} onValueChange={setAspectRatio}>
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
                    Generating...
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    Generate Video
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
              <CardTitle>Result</CardTitle>
              <CardDescription>
                Your generated cinematic clip will appear here.
              </CardDescription>
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
                  <div className="flex justify-center">
                    <Button variant="outline" onClick={() => setVideoUrl(null)}>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Create New
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
