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
  KeyRound,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { useRouter } from "next/navigation";

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
  XAI_IMAGE_MODELS,
  type CreditsInfo,
  type SpriteTemplateType,
  type XaiImageModelId,
  fetchBalanceUsd,
  fetchCreditsInfo,
  formatUsd,
  generateWithCredit,
  generateWithOwnKey,
} from "@/lib/ai-image";
import { useSharedProjectSource } from "@/lib/project/store";
import { cn } from "@/lib/utils";

type PayWith = "own-key" | "credit";

export default function GeneratePage() {
  return <GeneratePageContent />;
}

function GeneratePageContent() {
  const [selectedTemplateId, setSelectedTemplateId] = useState<SpriteTemplateType>("side-scroller");
  const [userPrompt, setUserPrompt] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [bgColor, setBgColor] = useState("green");
  const [model, setModel] = useState<XaiImageModelId>("grok-imagine-image");
  const [payWith, setPayWith] = useState<PayWith>("own-key");
  // The visitor's own xAI key lives only in this state: never stored, never
  // sent anywhere but api.x.ai.
  const [apiKey, setApiKey] = useState("");
  const [creditsInfo, setCreditsInfo] = useState<CreditsInfo | null>(null);
  const [balanceUsd, setBalanceUsd] = useState<number | null>(null);
  const { setSharedSource } = useSharedProjectSource();
  const router = useRouter();
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [isEditingTemplate, setIsEditingTemplate] = useState(false);
  const [customTemplate, setCustomTemplate] = useState("");

  const selectedTemplate = SPRITE_TEMPLATES.find((t) => t.id === selectedTemplateId)!;

  useEffect(() => {
    setCustomTemplate(selectedTemplate.basePrompt);
  }, [selectedTemplate.basePrompt]);

  useEffect(() => {
    void fetchCreditsInfo().then(setCreditsInfo);
    void fetchBalanceUsd().then(setBalanceUsd);
  }, []);

  const modelInfo = XAI_IMAGE_MODELS.find((m) => m.id === model)!;
  const creditPrice = creditsInfo?.models.find((m) => m.id === model)?.priceUsd ?? null;
  const creditReady = Boolean(creditsInfo?.generation) && balanceUsd !== null;

  const handleGenerate = async () => {
    if (!userPrompt) {
      toast.error("Please enter a character description.");
      return;
    }

    setIsGenerating(true);
    try {
      const templateToUse = isEditingTemplate ? customTemplate : selectedTemplate.basePrompt;
      const finalPrompt = templateToUse
        .replace("{prompt}", () => userPrompt)
        .replace("{bgcolor}", () => bgColor);

      if (payWith === "own-key") {
        if (!apiKey.trim()) {
          toast.error("Paste your xAI API key first.");
          return;
        }
        setGeneratedImageUrl(await generateWithOwnKey({ apiKey, model, prompt: finalPrompt }));
      } else {
        const result = await generateWithCredit({
          model,
          prompt: finalPrompt,
          requestKey: crypto.randomUUID(),
        });
        setGeneratedImageUrl(result.image);
        if (result.balanceUsd !== null) setBalanceUsd(result.balanceUsd);
        else void fetchBalanceUsd().then(setBalanceUsd);
      }
      toast.success("Image generated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to generate image.");
      if (payWith === "credit") void fetchBalanceUsd().then(setBalanceUsd);
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

  const handleUseInTools = async () => {
    if (!generatedImageUrl) return;
    try {
      const blob = await (await fetch(generatedImageUrl)).blob();
      const extension =
        blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
      await setSharedSource(new File([blob], `character.${extension}`, { type: blob.type }));
      router.push("/background-removal");
    } catch {
      toast.error("Could not load the image into the tools.");
    }
  };

  const handleDownload = async () => {
    if (!generatedImageUrl) return;
    try {
      const response = await fetch(generatedImageUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sprite-${Date.now()}.${blob.type === "image/png" ? "png" : "jpg"}`;
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
        <p className="text-muted-foreground">
          Generate character sprite art with xAI&rsquo;s image models.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Settings Panel */}
        <div className="space-y-6 lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wallet className="w-5 h-5" />
                How to pay for images
              </CardTitle>
              <CardDescription>Each image costs real money at xAI. Pick who pays.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="How to pay">
                {(
                  [
                    ["own-key", "Your own xAI key"],
                    ["credit", "AI credit"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={payWith === value}
                    variant={payWith === value ? "default" : "outline"}
                    size="sm"
                    onClick={() => setPayWith(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              {payWith === "own-key" ? (
                <div className="space-y-2 text-xs text-muted-foreground">
                  <Label htmlFor="xai-key" className="flex items-center gap-2 text-foreground">
                    <KeyRound className="w-4 h-4" />
                    xAI API key
                  </Label>
                  <Input
                    id="xai-key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="xai-…"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  <p>
                    Your browser sends the prompt and the key straight to xAI. The key stays in this
                    tab&rsquo;s memory. It never reaches the sprite-tools server, and it is gone
                    when you close the tab.
                  </p>
                  <p>
                    xAI bills your own account: {formatUsd(XAI_IMAGE_MODELS[0].costUsd)} per image
                    with {XAI_IMAGE_MODELS[0].label}, {formatUsd(XAI_IMAGE_MODELS[1].costUsd)} with{" "}
                    {XAI_IMAGE_MODELS[1].label}. No account here. Get a key at{" "}
                    <a
                      href="https://console.x.ai"
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      console.x.ai
                    </a>
                    .
                  </p>
                </div>
              ) : !creditsInfo?.generation ? (
                <p className="text-xs text-muted-foreground">
                  AI credit is not available on this server. Use your own xAI key instead.
                </p>
              ) : (
                <div className="space-y-2 text-xs text-muted-foreground">
                  <p>
                    The sprite-tools server makes the image with its own xAI key and takes the price
                    from your prepaid credit. The price is xAI&rsquo;s list price plus a{" "}
                    {creditsInfo.marginPercent}% margin:{" "}
                    {creditsInfo.models
                      .map((m) => `${formatUsd(m.priceUsd)} per image with ${m.label}`)
                      .join(", ")}
                    .
                  </p>
                  {balanceUsd === null ? (
                    <p>
                      AI credit needs an account, and that is all an account is for.{" "}
                      <Link href="/account" className="underline underline-offset-2">
                        Sign in or create one
                      </Link>
                      .
                    </p>
                  ) : (
                    <p className="text-foreground">
                      Your credit: {formatUsd(balanceUsd)}.{" "}
                      <Link href="/account" className="underline underline-offset-2">
                        Add credit
                      </Link>
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

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
                <Select value={model} onValueChange={(v) => v && setModel(v as XaiImageModelId)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {XAI_IMAGE_MODELS.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {payWith === "own-key"
                    ? `${formatUsd(modelInfo.costUsd)} per image, billed by xAI.`
                    : creditPrice !== null
                      ? `${formatUsd(creditPrice)} per image from your credit.`
                      : "AI credit is not available on this server."}
                </p>
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
                disabled={isGenerating || (payWith === "credit" && !creditReady)}
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
                    <Button size="sm" onClick={handleUseInTools}>
                      Remove the background
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
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
