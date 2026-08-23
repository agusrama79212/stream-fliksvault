"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import ShareModal from "@/components/ShareModal";
import { supabase } from "@/lib/supabase";
import { Content, ShareData } from "@/lib/types";
import { bulkInjectAction, bulkDeleteAction } from "@/lib/actions";

const SIDEBAR_LINKS = [
  { href: "/admin/dashboard", label: "Daftar Konten", id: "nav-list" },
  { href: "/admin/dashboard/tambah", label: "Tambah Konten", id: "nav-add" },
  { href: "/admin/dashboard/pengaturan", label: "Pengaturan", id: "nav-settings" },
  { href: "/", label: "Lihat Website", id: "nav-site" },
];

export default function AdminDashboardPage() {
  const router = useRouter();
  const [contents, setContents] = useState<Content[]>([]);
  const [shareTarget, setShareTarget] = useState<ShareData | null>(null);
  const [isInjecting, setIsInjecting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [authChecked, setAuthChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Pagination states
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const PAGE_SIZE = 50;

  // Progress states for injection
  const [injectProgress, setInjectProgress] = useState(0);
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [injectStats, setInjectStats] = useState({ total: 0, processed: 0, success: 0, skipped: 0 });

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Verifikasi sesi aktif — sebagai lapisan keamanan kedua setelah middleware
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }: { data: { user: import('@supabase/supabase-js').User | null } }) => {
      if (!user) {
        router.replace("/admin");
      } else {
        setAuthChecked(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effect terpisah untuk trigger fetch data (mendukung debounce pencarian)
  useEffect(() => {
    if (!authChecked) return;
    const timer = setTimeout(() => {
      loadContents(page, searchQuery);
    }, 500);
    return () => clearTimeout(timer);
  }, [authChecked, page, searchQuery]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace("/admin");
    router.refresh();
  };

  const loadContents = async (currentPage = page, query = searchQuery) => {
    setIsLoading(true);
    let queryBuilder = supabase
      .from("contents")
      .select("*, episodes(id)", { count: "exact" });

    // Server-side search support
    if (query.trim()) {
      const safeQuery = query.trim().replace(/[^a-zA-Z0-9]/g, '');
      const searchPattern = safeQuery.split('').join('[-\\s:]?');
      queryBuilder = queryBuilder.filter("title", "imatch", searchPattern);
    }

    const from = (currentPage - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, count, error } = await queryBuilder
      .order("created_at", { ascending: false })
      .range(from, to);

    if (data) {
      setContents(data as any);
      if (count !== null) setTotalCount(count);
      setSelectedIds([]);
    }
    setIsLoading(false);
  };

  // loadContents dipanggil setelah authChecked — tidak perlu useEffect terpisah
  // (sudah dipanggil di dalam auth check di atas)

  const handleShareClick = (content: Content) => {
    setShareTarget({
      title: content.title,
      slug: content.slug,
      posterUrl: content.poster_url ?? "",
      synopsis: content.synopsis ?? "",
    });
  };

  const handleDelete = async (id: string, title: string) => {
    if (!window.confirm(`Yakin ingin menghapus film/series "${title}"? Data tidak dapat dikembalikan.`)) return;

    try {
      const { error } = await supabase.from("contents").delete().eq("id", id);
      if (error) throw error;
      setContents(contents.filter(c => c.id !== id));
      alert("Konten berhasil dihapus.");
    } catch (err) {
      console.error("Gagal menghapus:", err);
      alert("Terjadi kesalahan saat menghapus konten.");
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const jsonData = JSON.parse(text);

      if (!Array.isArray(jsonData)) {
        throw new Error("Format JSON tidak valid. Harus berupa Array.");
      }

      const totalItems = jsonData.length;
      if (totalItems === 0) {
        alert("File JSON kosong.");
        return;
      }

      setIsInjecting(true);
      setShowProgressModal(true);
      setInjectProgress(0);
      setInjectStats({ total: totalItems, processed: 0, success: 0, skipped: 0 });

      const chunkSize = 5;
      let successCount = 0;
      let skippedCount = 0;
      let processedCount = 0;

      for (let i = 0; i < totalItems; i += chunkSize) {
        const chunk = jsonData.slice(i, i + chunkSize);
        const res = await bulkInjectAction(chunk);

        if (res.success) {
          successCount += res.inserted || 0;
          skippedCount += res.skipped || 0;
        } else {
          console.error(`Gagal injeksi chunk ${i}:`, res.error);
        }

        processedCount += chunk.length;
        setInjectStats({ total: totalItems, processed: processedCount, success: successCount, skipped: skippedCount });
        setInjectProgress(Math.round((processedCount / totalItems) * 100));
      }

      // Beri sedikit delay sebelum alert agar animasi 100% terlihat selesai
      setTimeout(() => {
        alert(`Injeksi selesai! Berhasil: ${successCount}, Dilewati (sudah ada): ${skippedCount}`);
        setShowProgressModal(false);
        setInjectProgress(0);
        loadContents();
      }, 500);

    } catch (err: any) {
      console.error(err);
      alert(`Terjadi kesalahan: ${err.message}`);
      setShowProgressModal(false);
    } finally {
      setIsInjecting(false);
      // Reset input file
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  // Hapus filter client-side karena pencarian sudah dipindah ke server-side
  const filteredContents = contents;

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedIds(filteredContents.map(c => c.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleSelectRow = (id: string, checked: boolean) => {
    if (checked) {
      setSelectedIds([...selectedIds, id]);
    } else {
      setSelectedIds(selectedIds.filter(selectedId => selectedId !== id));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`Yakin ingin menghapus ${selectedIds.length} konten yang dipilih? Data tidak dapat dikembalikan.`)) return;

    try {
      setIsDeleting(true);
      const res = await bulkDeleteAction(selectedIds);
      if (res.success) {
        alert("Konten terpilih berhasil dihapus.");
        loadContents();
      } else {
        alert(`Gagal menghapus data: ${res.error}`);
      }
    } catch (err: any) {
      console.error(err);
      alert(`Terjadi kesalahan: ${err.message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  // Tampilkan loading sementara auth dicek
  if (!authChecked) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-secondary)",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🔐</div>
          <p style={{ fontSize: "0.9rem" }}>Memverifikasi sesi...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-wrapper" style={{ paddingTop: 0 }}>
      {/* Sidebar */}
      <aside className="admin-sidebar">
        <div className="admin-sidebar-logo">
          <span className="logo-text">Admin<span>Panel</span></span>
        </div>
        <nav>
          <ul className="sidebar-nav">
            {SIDEBAR_LINKS.map((link) => (
              <li key={link.id}>
                <Link
                  id={link.id}
                  href={link.href}
                  className={link.href === "/admin/dashboard" ? "active" : ""}
                >
                  {link.label}
                </Link>
              </li>
            ))}
            <li>
              <button
                id="nav-logout"
                onClick={handleLogout}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "0.6rem 1rem",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--error, #f85149)",
                  fontSize: "0.9rem",
                  width: "100%",
                  textAlign: "left",
                  transition: "background 0.2s",
                }}
                onMouseEnter={(e) =>
                ((e.target as HTMLElement).style.background =
                  "rgba(248, 81, 73, 0.1)")
                }
                onMouseLeave={(e) =>
                  ((e.target as HTMLElement).style.background = "none")
                }
              >
                Logout
              </button>
            </li>
          </ul>
        </nav>
      </aside>

      {/* Main */}
      <main className="admin-main">
        <div className="admin-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
          <h1 className="admin-page-title" style={{ margin: 0 }}>Daftar Konten</h1>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            {selectedIds.length > 0 && (
              <button
                className="btn btn-danger btn-sm"
                onClick={handleBulkDelete}
                disabled={isDeleting}
              >
                {isDeleting ? "Menghapus..." : `🗑 Hapus Terpilih (${selectedIds.length})`}
              </button>
            )}
            <input
              type="file"
              accept=".json"
              ref={fileInputRef}
              style={{ display: "none" }}
              onChange={handleFileUpload}
            />
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isInjecting}
            >
              {isInjecting ? "Menginjeksi..." : "Auto Inject (JSON)"}
            </button>
            <Link href="/admin/dashboard/tambah" className="btn btn-admin btn-sm">
              + Tambah Konten
            </Link>
          </div>
        </div>

        {/* Stats Cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            gap: "1rem",
            marginBottom: "1.5rem",
          }}
        >
          {[
            { label: "Total Konten", value: contents.length, icon: "🎬" },
            { label: "Film", value: contents.filter((c) => c.type === "film").length, icon: "🎥" },
            { label: "Series/Anime", value: contents.filter((c) => c.type === "series").length, icon: "📺" },
          ].map((stat) => (
            <div
              key={stat.label}
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                padding: "1rem",
              }}
            >
              <div style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>{stat.icon}</div>
              <div style={{ fontSize: "1.6rem", fontWeight: 800 }}>{stat.value}</div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>{stat.label}</div>
            </div>
          ))}
        </div>

        <div style={{ flex: 1, minWidth: "250px", maxWidth: "100%", padding: "1rem 0" }}>
          <input
            type="text"
            placeholder="🔍 Cari judul film (otomatis mencari ke database)..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1); // Reset ke halaman pertama saat mencari
            }}
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: "var(--bg-surface)",
              color: "var(--text)",
              outline: "none"
            }}
          />
        </div>

        {/* Table */}
        <div className="table-wrapper">
          {isLoading && (
            <div style={{ padding: "1rem", textAlign: "center", color: "var(--text-secondary)" }}>
              Memuat data...
            </div>
          )}
          <table className="data-table" style={{ opacity: isLoading ? 0.5 : 1, transition: "opacity 0.2s" }}>
            <thead>
              <tr>
                <th style={{ width: "40px", textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={filteredContents.length > 0 && selectedIds.length === filteredContents.length}
                    onChange={handleSelectAll}
                  />
                </th>
                <th>Konten</th>
                <th>Tipe</th>
                <th>Tahun</th>
                <th>Episode</th>
                <th>Rating</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {filteredContents.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: "2rem", color: "var(--text-secondary)" }}>
                    Tidak ada konten yang sesuai pencarian.
                  </td>
                </tr>
              ) : (
                filteredContents.map((content) => (
                  <tr key={content.id}>
                    <td style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(content.id)}
                        onChange={(e) => handleSelectRow(content.id, e.target.checked)}
                      />
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                        {content.poster_url && (
                          <Image
                            src={content.poster_url}
                            alt={content.title}
                            width={36}
                            height={52}
                            style={{ borderRadius: "4px", objectFit: "cover", flexShrink: 0 }}
                          />
                        )}
                        <div>
                          <div style={{ fontWeight: 600, marginBottom: "0.15rem" }}>
                            {content.title}
                          </div>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                            /nonton/{content.slug}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`type-badge ${content.type === "series" ? "type-badge-series" : "type-badge-film"}`}>
                        {content.type === "series" ? "Series" : "Film"}
                      </span>
                    </td>
                    <td>{content.year}</td>
                    <td>
                      {content.type === "series"
                        ? `${content.episodes?.length ?? 0} Eps`
                        : "1 Link"}
                    </td>
                    <td>⭐ {content.rating?.toFixed(1) ?? "-"}</td>
                    <td>
                      <div className="table-actions">
                        <Link
                          href={`/admin/dashboard/edit/${content.slug}`}
                          className="btn btn-ghost btn-sm"
                        >
                          Edit
                        </Link>
                        <button
                          id={`share-btn-${content.id}`}
                          className="btn btn-admin btn-sm"
                          onClick={() => handleShareClick(content)}
                        >
                          Share
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDelete(content.id, content.title)}
                        >
                          Hapus
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination UI */}
        {totalCount > PAGE_SIZE && (
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "1.5rem",
            padding: "1rem",
            background: "var(--bg-surface)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border)"
          }}>
            <div style={{ fontSize: "0.9rem", color: "var(--text-secondary)" }}>
              Menampilkan {((page - 1) * PAGE_SIZE) + 1} - {Math.min(page * PAGE_SIZE, totalCount)} dari {totalCount} konten
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button 
                className="btn btn-ghost btn-sm" 
                disabled={page === 1 || isLoading}
                onClick={() => setPage(page - 1)}
              >
                ← Sebelumnya
              </button>
              <div style={{ padding: "0.4rem 1rem", background: "var(--bg-card)", borderRadius: "var(--radius-sm)", fontWeight: 600 }}>
                Halaman {page} dari {Math.ceil(totalCount / PAGE_SIZE)}
              </div>
              <button 
                className="btn btn-ghost btn-sm" 
                disabled={page >= Math.ceil(totalCount / PAGE_SIZE) || isLoading}
                onClick={() => setPage(page + 1)}
              >
                Selanjutnya →
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Share Modal */}
      {shareTarget && (
        <ShareModal
          data={shareTarget}
          isOpen={!!shareTarget}
          onClose={() => setShareTarget(null)}
        />
      )}

      {/* Progress Modal */}
      {showProgressModal && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            background: 'var(--bg-surface, #1F1813)',
            padding: '2.5rem',
            borderRadius: '16px',
            width: '90%',
            maxWidth: '500px',
            textAlign: 'center',
            boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
            border: '1px solid rgba(255,255,255,0.1)'
          }}>
            <h2 style={{ marginBottom: '1rem', fontSize: '1.75rem', fontWeight: 700, color: '#fff' }}>
              {injectProgress === 100 ? 'Selesai!' : 'Menginjeksi Data...'}
            </h2>
            <p style={{ color: 'var(--text-secondary, #9CA3AF)', marginBottom: '2rem', fontSize: '0.95rem' }}>
              Mohon tunggu, kami sedang memproses data film dan series Anda.
              Proses ini mungkin memakan waktu beberapa saat.
            </p>

            {/* Progress Bar Container */}
            <div style={{
              width: '100%',
              height: '32px',
              background: 'rgba(255,255,255,0.1)',
              borderRadius: '20px',
              position: 'relative',
              overflow: 'hidden',
              boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.1)'
            }}>
              {/* Progress Bar Fill */}
              <div style={{
                height: '100%',
                width: `${injectProgress}%`,
                background: 'linear-gradient(90deg, var(--gold, #E85D04) 0%, #fff 100%)',
                borderRadius: '20px',
                transition: 'width 0.3s ease-out',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                paddingRight: '12px',
                minWidth: '40px'
              }}>
                <span style={{
                  color: '#000',
                  fontWeight: 800,
                  fontSize: '0.85rem',
                  textShadow: '0 1px 2px rgba(255,255,255,0.5)'
                }}>
                  {injectProgress}%
                </span>
              </div>
            </div>

            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: '1rem',
              fontSize: '0.85rem',
              color: 'var(--text-secondary, #9CA3AF)'
            }}>
              <span>Diproses: {injectStats.processed} / {injectStats.total}</span>
              <span>Berhasil: <span style={{ color: '#4ade80' }}>{injectStats.success}</span> | Dilewati: <span style={{ color: '#fbbf24' }}>{injectStats.skipped}</span></span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
