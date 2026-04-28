"use client";

import { useState, useEffect } from "react";
import {
  Sparkles,
  Image as ImageIcon,
  Settings2,
  Palette,
  MessageSquare,
  Download,
  ArrowRight,
  RefreshCw,
  Edit3,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  SPRITE_TEMPLATES,
  POLLINATIONS_MODELS,
  type SpriteTemplateType,
  generateImage,
} from "@/lib/image-gen";
import { cn } from "@/lib/utils";
import { AuthWall } from "@/components/auth-wall";
import { AiGate } from "@/components/ai-gate";

export default function GeneratePage() {
  return (
    <AiGate
      feature="AI Character"
      description="Generate character sprite art from a text prompt using AI image generation."
    >
      <AuthWall
        feature="AI Character"
        description="Generate character sprite art from a text prompt using AI image generation."
        costHint="~1 credit per image"
      >
        <GeneratePageContent />
      </AuthWall>
    </AiGate>
  );
}

function GeneratePageContent() {
  const [selectedTemplateId, setSelectedTemplateId] = useState<SpriteTemplateType>("side-scroller");
  const [userPrompt, setUserPrompt] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [bgColor, setBgColor] = useState("green");
  const [model, setModel] = useState("flux");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [isEditingTemplate, setIsEditingTemplate] = useState(false);
  const [customTemplate, setCustomTemplate] = useState("");

  const selectedTemplate = SPRITE_TEMPLATES.find((t) => t.id === selectedTemplateId)!;

  useEffect(() => {
    setCustomTemplate(selectedTemplate.basePrompt);
  }, [selectedTemplate.basePrompt]);

  const handleGenerate = async () => {
    if (!userPrompt) {
      toast.error("Please enter a character description.");
      return;
    }

    setIsGenerating(true);
    try {
      const templateToUse = isEditingTemplate ? customTemplate : selectedTemplate.basePrompt;
      const finalPrompt = templateToUse
        .replace("{prompt}", userPrompt)
        .replace("{bgcolor}", bgColor);

      const url = await generateImage(finalPrompt, { model });
      setGeneratedImageUrl(url);
      toast.success("Image generated!");
    } catch (error) {
      toast.error("Failed to generate image.");
      console.error(error);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput) return;

    // Simple refinement: append to prompt
    setUserPrompt((prev) => (prev ? `${prev}, ${chatInput}` : chatInput));
    setChatInput("");
    toast.success("Prompt refined!");
  };

  const handleDownload = async () => {
    if (!generatedImageUrl) return;
    try {
      const response = await fetch(generatedImageUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sprite-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error("Failed to download image.");
    }
  };

  return (
    <main className="flex-1 container max-w-6xl mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <Sparkles className="w-8 h-8 text-primary" />
          AI Character
        </h1>
        <p className="text-muted-foreground">Generate character sprite art with AI.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Settings Panel */}
        <div className="space-y-6 lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="w-5 h-5" />
                Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Template Type</Label>
                <Select
                  value={selectedTemplateId}
                  onValueChange={(v) => setSelectedTemplateId(v as SpriteTemplateType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SPRITE_TEMPLATES.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{selectedTemplate.description}</p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Template Text</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setIsEditingTemplate(!isEditingTemplate)}
                  >
                    {isEditingTemplate ? (
                      <Check className="w-3 h-3 mr-1" />
                    ) : (
                      <Edit3 className="w-3 h-3 mr-1" />
                    )}
                    {isEditingTemplate ? "Done" : "Edit"}
                  </Button>
                </div>
                {isEditingTemplate ? (
                  <Textarea
                    value={customTemplate}
                    onChange={(e) => setCustomTemplate(e.target.value)}
                    className="text-xs font-mono h-32"
                  />
                ) : (
                  <div className="p-2 bg-muted rounded-md text-xs font-mono break-words border border-border italic text-muted-foreground">
                    {selectedTemplate.basePrompt}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground">
                  Use &#123;prompt&#125; and &#123;bgcolor&#125; as placeholders.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <Palette className="w-4 h-4" />
                  Background Color
                </Label>
                <Select value={bgColor} onValueChange={(v) => v && setBgColor(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="green">Green (Chroma Key)</SelectItem>
                    <SelectItem value="magenta">Magenta</SelectItem>
                    <SelectItem value="blue">Blue</SelectItem>
                    <SelectItem value="white">White</SelectItem>
                    <SelectItem value="black">Black</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Model</Label>
                <Select value={model} onValueChange={(v) => v && setModel(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {POLLINATIONS_MODELS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <MessageSquare className="w-4 h-4" />
                Refine Prompt (Chat)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleChatSubmit} className="flex gap-2">
                <Input
                  placeholder="e.g., 'wearing a red hat'..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                />
                <Button type="submit" size="sm">
                  Add
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        {/* Editor Panel */}
        <div className="space-y-6 lg:col-span-2">
          <Card className="flex flex-col h-full">
            <CardHeader>
              <CardTitle>Character Description</CardTitle>
              <CardDescription>Describe your character in detail.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                placeholder="A brave female knight with silver armor and a flowing blue cape..."
                className="h-32 text-lg"
                value={userPrompt}
                onChange={(e) => setUserPrompt(e.target.value)}
              />

              <Button
                onClick={handleGenerate}
                disabled={isGenerating}
                className="w-full h-12 text-lg"
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
                    Generating Sprite...
                  </>
                ) : (
                  <>
                    <ImageIcon className="mr-2 h-5 w-5" />
                    Generate Image
                  </>
                )}
              </Button>
            </CardContent>

            <div className="flex-1 flex flex-col p-6 pt-0 border-t mt-4">
              <div className="flex items-center justify-between mb-4 mt-4">
                <h3 className="font-semibold">Preview Result</h3>
                {generatedImageUrl && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={handleDownload}>
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </Button>
                    <Link
                      href={`/animate?imageUrl=${encodeURIComponent(generatedImageUrl)}`}
                      className={cn(
                        "inline-flex items-center justify-center rounded-lg h-7 px-2.5 text-[0.8rem] font-medium bg-green-600 text-white hover:bg-green-700 transition-colors",
                      )}
                    >
                      Use for Animation
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Link>
                  </div>
                )}
              </div>

              <div
                className={cn(
                  "flex-1 min-h-[400px] border-2 border-dashed rounded-lg flex items-center justify-center overflow-hidden bg-muted/20",
                  !generatedImageUrl && "text-muted-foreground",
                )}
              >
                {generatedImageUrl ? (
                  <img
                    src={generatedImageUrl}
                    alt="Generated Sprite"
                    className="max-w-full max-h-full object-contain shadow-xl"
                  />
                ) : isGenerating ? (
                  <div className="flex flex-col items-center gap-4">
                    <RefreshCw className="w-12 h-12 animate-spin text-primary" />
                    <p>Generating character art...</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <ImageIcon className="w-16 h-16 opacity-20" />
                    <p>Generated image will appear here</p>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
