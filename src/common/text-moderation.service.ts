import { Injectable } from '@nestjs/common';

// Word-boundary matched — deliberately excludes generic terms ("sex", "adult")
// that show up in ordinary matrimonial-app conversation; only unambiguous
// profanity/slurs and adult-industry terms/site names are listed.
const PROFANITY_WORDS = [
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch',
  'asshole', 'bastard', 'cunt', 'dick', 'pussy', 'whore', 'slut', 'retard',
  'nigger', 'nigga', 'faggot', 'chink', 'spic', 'paki',
];

const ADULT_TERMS = [
  'porn', 'porno', 'pornography', 'xxx', 'nudes', 'nude photos', 'sex tape',
  'onlyfans', 'escort service', 'camgirl', 'cam girl', 'hardcore video',
  'xvideos', 'xnxx', 'pornhub', 'redtube', 'xhamster', 'brazzers', 'youporn',
];

export interface ModerationResult {
  blocked: boolean;
  reason?: string;
}

@Injectable()
export class TextModerationService {
  private readonly profanityRegex = TextModerationService.buildWordRegex(PROFANITY_WORDS);
  private readonly adultRegex = TextModerationService.buildWordRegex(ADULT_TERMS);

  private static buildWordRegex(words: string[]): RegExp {
    const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
    return new RegExp(`\\b(${escaped.join('|')})\\b`, 'i');
  }

  check(text?: string | null): ModerationResult {
    if (!text || !text.trim()) return { blocked: false };
    const normalized = text.toLowerCase();

    if (this.profanityRegex.test(normalized)) {
      return { blocked: true, reason: 'Please remove inappropriate language before posting.' };
    }
    if (this.adultRegex.test(normalized)) {
      return { blocked: true, reason: "That kind of content isn't allowed on MrKapu." };
    }
    return { blocked: false };
  }
}
